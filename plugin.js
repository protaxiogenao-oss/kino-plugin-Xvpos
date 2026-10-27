// Kino plugin: XVideos — v1.5.0
// Home reordenado, filas hasta 60, browse 100, títulos limpios, thumbs 16:9.
// Cuenta opcional para favoritos / playlists.

const BASE = "https://www.xvideos.com";

function log(...args) {
  try {
    kino.log(...args);
  } catch {
    // ignore
  }
}

function cleanText(s) {
  let t = String(s || "");
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&comma;/g, ",")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&uuml;/g, "ü")
    .replace(/&Aacute;/g, "Á")
    .replace(/&Eacute;/g, "É")
    .replace(/&Iacute;/g, "Í")
    .replace(/&Oacute;/g, "Ó")
    .replace(/&Uacute;/g, "Ú")
    .replace(/&iquest;/g, "¿")
    .replace(/&iexcl;/g, "¡");
  t = t.replace(/&#(\d+);/g, (_, n) => {
    try {
      return String.fromCharCode(Number(n));
    } catch {
      return "";
    }
  });
  t = t.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    try {
      return String.fromCharCode(parseInt(h, 16));
    } catch {
      return "";
    }
  });
  t = t.replace(/_/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function normalizeTitle(raw) {
  let t = cleanText(raw);
  if (!t) return "";
  if (/^\/video\./i.test(t) || /^video\./i.test(t)) return "";
  t = t.replace(/\s*([|·•])\s*/g, " · ");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 180) t = t.slice(0, 177) + "…";
  return t;
}

function parseDuration(text) {
  const t = String(text || "").toLowerCase();
  const h = /(\d+)\s*h/.exec(t);
  const m = /(\d+)\s*min/.exec(t);
  let minutes = 0;
  if (h) minutes += parseInt(h[1], 10) * 60;
  if (m) minutes += parseInt(m[1], 10);
  return minutes > 0 ? minutes : undefined;
}

function preferredQuality() {
  const q = String(kino.config.get("quality") || "hls").toLowerCase();
  if (q === "low" || q === "hls") return q;
  return "high";
}

function searchParams() {
  return {
    sort: String(kino.config.get("sort") || "relevance"),
    duration: String(kino.config.get("duration") || "allduration"),
    onlyHd: kino.config.get("onlyHd") === true,
  };
}

function extractId(ref) {
  const s = String(ref || "").trim();
  if (!s) return "";
  let m = /(?:^|\/)video\.([a-zA-Z0-9._-]+)/.exec(s);
  if (m) return m[1];
  m = /(?:^|\/)video(\d{5,})(?:\/|$)/.exec(s);
  if (m) return m[1];
  return s.split(/[|/]/)[0].replace(/[^a-zA-Z0-9._-]/g, "");
}

function toItem(v) {
  // XVideos thumbs are landscape 16:9 — poster + backdrop for horizontal display
  const thumb = v.thumb || undefined;
  return {
    id: v.id,
    ref: v.id,
    title: v.title,
    kind: "movie",
    poster: thumb,
    backdrop: thumb,
    quality: v.hd ? v.hdLabel || "HD" : undefined,
    runtimeMinutes: v.durationMin,
    overview: v.duration || undefined,
    adult: true,
  };
}

/** Prefer a 16:9 landscape thumbnail URL from a card block. */
function pickLandscapeThumb(block) {
  const candidates = [];
  const re =
    /(?:data-src|data-sfwthumb|src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|webp|png)[^"]*)"/gi;
  let m;
  while ((m = re.exec(block))) {
    const u = m[1];
    if (/blank\.gif|lightbox|sprite|logo|icon/i.test(u)) continue;
    candidates.push(u);
  }
  const score = (u) => {
    let s = 0;
    if (/thumbs?169|16x9|16-9|\/169\//i.test(u)) s += 5;
    if (/xv_\d+_t\.jpg/i.test(u)) s += 3;
    if (/thumb-cdn|thumbs-gcore|xvideos-cdn/i.test(u)) s += 2;
    if (/\/thumbs?\//i.test(u)) s += 1;
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || undefined;
}

function parseVideoCards(html) {
  const items = [];
  const seen = new Set();
  const starts = [];
  // Home / categories: id="video_XXXX"
  // /best and some listings: id="video-thumb-XXXX" (hyphen, not underscore)
  const startRe =
    /<div[^>]*\bid="video(?:-thumb)?[_-]([a-zA-Z0-9._-]+)"[^>]*>/gi;
  let sm;
  while ((sm = startRe.exec(html)) !== null) {
    starts.push({ id: sm[1], index: sm.index });
  }

  for (let i = 0; i < starts.length; i++) {
    const id = starts[i].id;
    if (seen.has(id)) continue;
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : from + 4000;
    const block = html.slice(from, Math.min(to, from + 4500));

    let title = "";
    const titleAttr =
      /<p[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]*title="([^"]+)"/i.exec(
        block
      ) ||
      /<a[^>]*href="\/video\.[^"]*"[^>]*title="([^"]+)"/i.exec(block) ||
      /title="([^"]{4,200})"/i.exec(block);
    if (titleAttr) title = normalizeTitle(titleAttr[1]);
    if (!title || title.length < 2) {
      const titleText =
        /<p[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="\/video\.[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
          block
        );
      if (titleText) {
        title = normalizeTitle(
          titleText[1].replace(/<span[^>]*>[\s\S]*?<\/span>/gi, "")
        );
      }
    }
    if (!title || title.length < 2) {
      const hrefM =
        /href="\/video\.[a-zA-Z0-9._-]+\/(?:\d+\/\d+\/)?([^"?#]+)/i.exec(block);
      if (hrefM) {
        try {
          title = normalizeTitle(decodeURIComponent(hrefM[1]));
        } catch (_) {
          title = normalizeTitle(hrefM[1]);
        }
      }
    }
    if (!title || title.length < 2) continue;

    const thumb = pickLandscapeThumb(block);

    let duration;
    let durationMin;
    const dur =
      /<span[^>]*class="[^"]*duration[^"]*"[^>]*>([^<]+)</i.exec(block) ||
      /class="duration"[^>]*>([^<]+)</i.exec(block);
    if (dur) {
      duration = cleanText(dur[1]);
      durationMin = parseDuration(duration);
    }

    const hdMark =
      /<span[^>]*class="[^"]*video-hd-mark[^"]*"[^>]*>([^<]*)</i.exec(block);
    const hd = !!hdMark || /video-hd-mark/i.test(block);
    let hdLabel = hdMark ? cleanText(hdMark[1]) || "HD" : hd ? "HD" : undefined;
    if (/1080|4k/i.test(block)) hdLabel = hdLabel || "1080p";

    seen.add(id);
    items.push({
      id,
      title: title.slice(0, 200),
      thumb,
      duration,
      durationMin,
      hd,
      hdLabel,
    });
  }

  if (items.length < 8) {
    const linkRe =
      /<a[^>]*href="\/video\.([a-zA-Z0-9._-]+)\/[^"]*"[^>]*title="([^"]+)"[^>]*>/gi;
    let lm;
    while ((lm = linkRe.exec(html)) !== null) {
      const id = lm[1];
      if (seen.has(id)) continue;
      const title = normalizeTitle(lm[2]);
      if (!title || title.length < 2) continue;
      seen.add(id);
      const around = html.slice(Math.max(0, lm.index - 800), lm.index + 200);
      items.push({
        id,
        title: title.slice(0, 200),
        thumb: pickLandscapeThumb(around),
        duration: undefined,
        durationMin: undefined,
        hd: /video-hd-mark/i.test(around),
        hdLabel: undefined,
      });
    }
  }

  return items;
}

async function fetchPage(path, opts) {
  const url = path.startsWith("http") ? path : BASE + path;
  const r = await kino.fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.95,en-US;q=0.5,en;q=0.4",
      Referer: BASE + "/",
      ...(opts && opts.headers),
    },
    method: (opts && opts.method) || "GET",
    body: opts && opts.body,
    cookies: true,
    timeoutMs: 15000,
  });
  return r;
}

function buildSearchPath(q, page, params) {
  const parts = ["k=" + encodeURIComponent(q)];
  if (params.sort && params.sort !== "relevance") {
    parts.push("sort=" + encodeURIComponent(params.sort));
  }
  if (params.duration && params.duration !== "allduration") {
    parts.push("durf=" + encodeURIComponent(params.duration));
  }
  if (params.onlyHd) parts.push("quality=hd");
  if (page > 0) parts.push("p=" + page);
  return "/?" + parts.join("&");
}

function extractStreams(html) {
  const pick = (...pats) => {
    for (const p of pats) {
      const m = p.exec(html);
      if (m && m[1]) return m[1];
    }
    return null;
  };
  return {
    hls: pick(
      /setVideoHLS\(['"]([^'"]+)['"]\)/,
      /html5player\.setVideoHLS\(['"]([^'"]+)['"]\)/,
      /"(https?:\/\/[^"]+\.m3u8[^"]*)"/,
      /'(https?:\/\/[^']+\.m3u8[^']*)'/
    ),
    high: pick(
      /setVideoUrlHigh\(['"]([^'"]+)['"]\)/,
      /html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/
    ),
    low: pick(
      /setVideoUrlLow\(['"]([^'"]+)['"]\)/,
      /html5player\.setVideoUrlLow\(['"]([^'"]+)['"]\)/
    ),
    mp4: pick(/"(https?:\/\/[^"]+\.mp4[^"]*)"/, /'(https?:\/\/[^']+\.mp4[^']*)'/),
    og: pick(
      /property="og:video(?::url)?"\s+content="([^"]+)"/i,
      /content="([^"]+)"\s+property="og:video(?::url)?"/i
    ),
  };
}

function expirySeconds(url) {
  if (!url) return undefined;
  const m = /[?&,]secure=[^,&]+,(\d{9,12})/.exec(url) || /[?&]e=(\d{9,12})/.exec(url);
  if (!m) return undefined;
  const exp = Number(m[1]);
  if (!exp) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const ts = exp > 1e12 ? Math.floor(exp / 1000) : exp;
  const left = ts - now;
  if (left < 30) return 30;
  if (left > 86400) return 3600;
  return left;
}

// ---- account / login ------------------------------------------------------


function hasCredentials() {
  const email = String(kino.config.get("email") || "").trim();
  const password = String(kino.config.get("password") || "");
  return !!(email && password);
}

/** True if the HTML looks like a logged-in account page (not the login form). */
function pageLooksLoggedIn(html) {
  if (!html) return false;
  if (/id="signin-form"/i.test(html) && /signin-form\[password\]/i.test(html)) {
    // login form present — not logged in (unless both)
    if (!/sign.?out|log.?out|cerrar sesión|my account|mi cuenta|account\/logout/i.test(html)) {
      return false;
    }
  }
  return /account\/logout|sign.?out|log.?out|data-user-id|my-favourites|\/favorite\//i.test(html);
}

async function isLoggedIn() {
  try {
    const r = await fetchPage("/account");
    if (!r.ok) return false;
    return pageLooksLoggedIn(r.text());
  } catch (e) {
    log("isLoggedIn", e.message || e);
    return false;
  }
}

async function doLogin() {
  const email = String(kino.config.get("email") || "").trim();
  const password = String(kino.config.get("password") || "");
  if (!email || !password) {
    return { ok: false, message: "Escribe correo y contraseña" };
  }

  // Load login page for CSRF
  let loginHtml;
  try {
    const r = await fetchPage("/account");
    if (!r.ok) return { ok: false, message: "No se pudo abrir la página de cuenta" };
    loginHtml = r.text();
  } catch (e) {
    return { ok: false, message: "Error de red al abrir cuenta" };
  }

  // Already logged in
  if (pageLooksLoggedIn(loginHtml) && !/id="signin-form"/i.test(loginHtml)) {
    return { ok: true, message: "Ya había sesión iniciada" };
  }

  const csrfM =
    /name="signin-form\[csrf_token\]"[^>]*value="([^"]+)"/i.exec(loginHtml) ||
    /value="([^"]+)"[^>]*name="signin-form\[csrf_token\]"/i.exec(loginHtml);
  if (!csrfM) {
    return { ok: false, message: "No se encontró el token de acceso" };
  }

  const form = {
    "signin-form[csrf_token]": csrfM[1],
    "signin-form[votes]": "",
    "signin-form[subs]": "",
    "signin-form[post_referer]": "",
    "signin-form[login]": email,
    "signin-form[password]": password,
    "signin-form[rememberme]": "on",
  };

  try {
    const r = await kino.fetch(BASE + "/account", {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        Referer: BASE + "/account",
        Origin: BASE,
      },
      body: { form },
      cookies: true,
      timeoutMs: 20000,
    });
    const body = r.text();
    // Success: redirect away from pure login form, or page shows account UI
    if (pageLooksLoggedIn(body) || (r.ok && !/signin-form\[password\]/i.test(body))) {
      // Double-check with a fresh /account
      if (await isLoggedIn()) {
        return { ok: true, message: "Sesión iniciada" };
      }
    }
    if (/invalid|incorrect|wrong password|error/i.test(body) && /signin-form/i.test(body)) {
      return { ok: false, message: "Usuario o contraseña incorrectos" };
    }
    // One more check
    if (await isLoggedIn()) return { ok: true, message: "Sesión iniciada" };
    return { ok: false, message: "No se pudo iniciar sesión" };
  } catch (e) {
    log("doLogin", e.message || e);
    return { ok: false, message: "Error al iniciar sesión" };
  }
}

async function doLogout() {
  try {
    await fetchPage("/account/logout");
  } catch (e) {
    log("logout get", e.message || e);
  }
  try {
    kino.cookies.clear();
  } catch (e) {
    log("cookies.clear", e.message || e);
  }
  return { message: "Sesión cerrada", clearSettings: [] };
}

/** Try several account list URLs and return cards if any look like video lists. */
async function fetchAccountLists() {
  const paths = [
    "/account",
    "/account/favorites",
    "/account/favourites",
    "/account/playlists",
    "/my-favourites",
  ];
  const out = [];
  const seenIds = new Set();

  for (const path of paths) {
    try {
      const r = await fetchPage(path);
      if (!r.ok) continue;
      const html = r.text();
      if (!pageLooksLoggedIn(html) && /signin-form\[password\]/i.test(html)) continue;
      const cards = parseVideoCards(html);
      if (!cards.length) continue;
      // Derive a row title from path
      let title = "Favoritos";
      if (/playlist/i.test(path)) title = "Playlists";
      else if (/favorite|favour/i.test(path)) title = "Favoritos";
      else title = "Mi cuenta";
      const fresh = cards.filter((c) => {
        if (seenIds.has(c.id)) return false;
        seenIds.add(c.id);
        return true;
      });
      if (fresh.length) {
        out.push({
          id: "acc-" + path.replace(/\W+/g, "-"),
          title,
          items: fresh.slice(0, 60).map(toItem),
          ref: path.replace(/^\//, ""),
        });
      }
    } catch (e) {
      log("account list", path, e.message || e);
    }
  }

  // Also try profile favorites if we can find a profile link
  try {
    const r = await fetchPage("/account");
    if (r.ok) {
      const html = r.text();
      const prof =
        /href="(\/profiles\/[^"/]+)/i.exec(html) ||
        /href="(\/[^"/]+\/favorites)/i.exec(html) ||
        /href="(\/favorite\/\d+)/i.exec(html);
      if (prof) {
        const path = prof[1];
        const r2 = await fetchPage(path);
        if (r2.ok) {
          const cards = parseVideoCards(r2.text()).filter((c) => !seenIds.has(c.id));
          if (cards.length) {
            out.push({
              id: "acc-profile-fav",
              title: "Favoritos",
              items: cards.slice(0, 60).map(toItem),
              ref: path.replace(/^\//, ""),
            });
          }
        }
      }
    }
  } catch (e) {
    log("profile fav", e.message || e);
  }

  return out;
}

// Settings UI hooks (apiVersion 6)
export async function settingsStatus() {
  const email = String(kino.config.get("email") || "").trim();
  if (!email) return { status: "Sin cuenta configurada" };
  try {
    const ok = await isLoggedIn();
    return { status: ok ? "Sesión activa (" + email + ")" : "Sin sesión — pulsa Iniciar sesión" };
  } catch {
    return { status: "No se pudo comprobar la sesión" };
  }
}

export async function action(key) {
  if (key === "login") {
    const res = await doLogin();
    return { message: res.message };
  }
  if (key === "logout") {
    return await doLogout();
  }
  return null;
}



// ---- search ---------------------------------------------------------------

export async function search(query) {
  const q = String(query.q || "").trim();
  if (!q) return [];

  const page = query.cursor ? Math.max(0, Number(query.cursor) || 0) : 0;
  const params = searchParams();

  let html;
  try {
    const r = await fetchPage(buildSearchPath(q, page, params));
    if (!r.ok) throw new Error("xvideos respondió " + r.status);
    html = r.text();
  } catch (e) {
    log("search failed", e.message);
    throw kino.error("unavailable", e.message);
  }

  let cards = parseVideoCards(html);
  if (params.onlyHd) cards = cards.filter((c) => c.hd);

  const qLower = q.toLowerCase();
  const qWords = qLower.split(/\s+/).filter((w) => w.length > 1);
  cards.sort((a, b) => {
    const at = a.title.toLowerCase();
    const bt = b.title.toLowerCase();
    const aExact = at.includes(qLower) ? 2 : 0;
    const bExact = bt.includes(qLower) ? 2 : 0;
    const aAll = qWords.length && qWords.every((w) => at.includes(w)) ? 1 : 0;
    const bAll = qWords.length && qWords.every((w) => bt.includes(w)) ? 1 : 0;
    const aScore =
      aExact +
      aAll +
      qWords.reduce((s, w) => s + (at.includes(w) ? 1 : 0), 0) +
      (a.hd ? 0.25 : 0);
    const bScore =
      bExact +
      bAll +
      qWords.reduce((s, w) => s + (bt.includes(w) ? 1 : 0), 0) +
      (b.hd ? 0.25 : 0);
    return bScore - aScore;
  });

  // maxSearchItems = 100
  const items = cards.slice(0, 100).map(toItem);
  const next = cards.length >= 20 ? String(page + 1) : undefined;
  return next ? { items, next } : items;
}

// ---- home -----------------------------------------------------------------

export async function home() {
  const rows = [];
  // maxHomeRows = 20, maxRowItems = 60
  const ROW_MAX = 60;
  // Videos already shown in an earlier row (avoid repeated titles across Home)
  const seenIds = new Set();

  // Category IDs verified 2026-10 against xvideos.com homepage.
  // /c/Japanese-27 is Interracial (wrong); Japanese is /tags/japanese only.
  // Amateur-13 / Teen-15 / Anal-25 were outdated → Amateur-65 / Teen-13 / Anal-12.
  const sections = [
    { id: "fresh", title: "Recientes", path: "/" },
    { id: "best", title: "Mejor valorados", path: "/best" },
    { id: "asian", title: "Asian", path: "/c/Asian_Woman-32" },
    { id: "japanese", title: "Japanese", path: "/tags/japanese" },
    { id: "latina", title: "Latina", path: "/c/Latina-16" },
    { id: "big-tits", title: "Big Tits", path: "/c/Big_Tits-23" },
    { id: "big-ass", title: "Big Ass", path: "/c/Big_Ass-24" },
    { id: "milf", title: "MILF", path: "/c/Milf-19" },
    { id: "amateur", title: "Amateur", path: "/c/Amateur-65" },
    { id: "teen", title: "Teen", path: "/c/Teen-13" },
    { id: "anal", title: "Anal", path: "/c/Anal-12" },
    { id: "cosplay", title: "Cosplay", path: "/tags/cosplay" },
    { id: "uncensored", title: "Uncensored", path: "/tags/uncensored" },
    { id: "hentai", title: "Hentai", path: "/tags/hentai" },
    { id: "black", title: "Black", path: "/c/Black_Woman-30" },
    { id: "creampie", title: "Creampie", path: "/c/Creampie-40" },
    { id: "lesbian", title: "Lesbian", path: "/c/Lesbian-26" },
    { id: "blonde", title: "Blonde", path: "/c/Blonde-20" },
    { id: "pov", title: "POV", path: "/tags/pov" },
    { id: "squirting", title: "Squirting", path: "/c/Squirting-56" },
  ];

  if (typeof hasCredentials === "function" && hasCredentials()) {
    try {
      let logged = await isLoggedIn();
      if (!logged) {
        const res = await doLogin();
        logged = res.ok;
      }
      if (logged) {
        const accRows = await fetchAccountLists();
        for (const row of accRows) {
          if (row && row.items && row.items.length) {
            const unique = row.items.filter(function (it) {
              if (!it || !it.id || seenIds.has(it.id)) return false;
              seenIds.add(it.id);
              return true;
            });
            if (unique.length) {
              rows.push({
                id: row.id,
                title: row.title,
                items: unique.slice(0, ROW_MAX),
                ref: row.ref,
              });
            }
          }
        }
      }
    } catch (e) {
      log("home account", e.message || e);
    }
  }

  for (const sec of sections) {
    if (rows.length >= 20) break;
    try {
      const r = await fetchPage(sec.path);
      if (!r.ok) continue;
      let cards = parseVideoCards(r.text());
      if (!cards.length) continue;
      // Drop videos already used in earlier rows
      cards = cards.filter(function (c) {
        if (!c.id || seenIds.has(c.id)) return false;
        return true;
      });
      if (cards.length < 6) continue;
      const slice = cards.slice(0, ROW_MAX);
      for (let i = 0; i < slice.length; i++) seenIds.add(slice[i].id);
      rows.push({
        id: sec.id,
        title: sec.title,
        items: slice.map(toItem),
        ref: sec.path.replace(/^\//, "") || "fresh",
      });
    } catch (e) {
      log("home", sec.id, e.message || e);
    }
  }

  return rows;
}

// ---- browse ---------------------------------------------------------------

export async function browse(ref, cursor) {
  // maxBrowseItems = 100
  const page = cursor ? Math.max(0, Number(cursor) || 0) : 0;
  let path = "/" + String(ref || "fresh").replace(/^\/+/, "");
  if (path === "/fresh" || path === "/") path = "/";

  if (page > 0) {
    if (
      path.startsWith("/c/") ||
      path.startsWith("/tags/") ||
      path.startsWith("/best")
    ) {
      if (!/\/\d+$/.test(path)) path = path.replace(/\/$/, "") + "/" + (page + 1);
      else path = path.replace(/\/\d+$/, "/" + (page + 1));
    } else {
      path += (path.includes("?") ? "&" : "?") + "p=" + page;
    }
  }

  let html;
  try {
    const r = await fetchPage(path);
    if (!r.ok) throw new Error("xvideos respondió " + r.status);
    html = r.text();
  } catch (e) {
    log("browse failed", e.message);
    throw kino.error("unavailable", e.message);
  }

  const cards = parseVideoCards(html);
  const items = cards.slice(0, 100).map(toItem);
  const next = cards.length >= 20 ? String(page + 1) : undefined;
  return { items, next };
}

// ---- resolve --------------------------------------------------------------

export async function resolve(ref) {
  await Promise.resolve();

  const id = extractId(ref);
  if (!id) throw kino.error("not_found", "ref vacío");

  const candidates = [
    BASE + "/video." + id + "/x",
    BASE + "/video." + id + "/watch",
    BASE + "/video." + id + "/" + id,
    BASE + "/video" + id + "/",
  ];

  let html = null;
  let finalUrl = null;

  for (const url of candidates) {
    try {
      const r = await kino.fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
          Accept: "text/html",
          Referer: BASE + "/",
        },
        cookies: true,
        timeoutMs: 15000,
      });
      if (!r.ok) continue;
      const body = r.text();
      if (
        /not found|página no encontrada|video not found/i.test(body) &&
        !/setVideoHLS|setVideoUrlHigh/i.test(body)
      ) {
        continue;
      }
      html = body;
      finalUrl = r.url;
      break;
    } catch (e) {
      log("resolve fetch", url, e.message || e);
    }
  }

  if (!html) throw kino.error("not_found", "vídeo no encontrado");

  const streams = extractStreams(html);
  const mp4Url = streams.high || streams.low || streams.mp4 || null;
  const hlsUrl = streams.hls || null;
  const pref = preferredQuality();

  const headers = {
    Referer: finalUrl || BASE + "/",
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    Origin: BASE,
  };

  let streamUrl = null;
  let label = "Directo";

  if (pref === "hls") {
    streamUrl = hlsUrl || mp4Url || streams.og;
    label = hlsUrl ? "HLS" : "MP4";
  } else if (pref === "low") {
    streamUrl = streams.low || mp4Url || hlsUrl || streams.og;
    label = streams.low || mp4Url ? "MP4" : "HLS";
  } else {
    streamUrl = mp4Url || hlsUrl || streams.og;
    label = mp4Url ? "MP4" : hlsUrl ? "HLS" : "Directo";
  }

  if (!streamUrl) throw kino.error("unavailable", "no se encontró el stream");

  const isHls = /\.m3u8(\?|$)/i.test(streamUrl);
  const alternatives = [];
  const addAlt = (url, altLabel) => {
    if (url && url !== streamUrl) {
      alternatives.push({
        url,
        label: altLabel,
        headers,
        mime: /\.m3u8(\?|$)/i.test(url) ? "application/x-mpegURL" : "video/mp4",
      });
    }
  };
  if (!isHls && hlsUrl) addAlt(hlsUrl, "HLS");
  if (isHls && mp4Url) addAlt(mp4Url, "MP4");
  if (streams.low && streams.low !== streamUrl) addAlt(streams.low, "Baja");

  return {
    url: streamUrl,
    mime: isHls ? "application/x-mpegURL" : "video/mp4",
    headers,
    label,
    expiresInSeconds: expirySeconds(streamUrl),
    alternatives: alternatives.length ? alternatives : undefined,
  };
}
