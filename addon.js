const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const crypto = require("crypto");

const M3U_URL =
  "https://raw.githubusercontent.com/Valchrist23/VikTV/master/y.m3u";

const manifest = {
  id: "org.viktv.personal",
  version: "1.0.0",
  name: "VikTV",
  description: "Mi colección personal de películas desde GitHub",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["viktv:"],
  catalogs: [
    {
      type: "movie",
      id: "viktv",
      name: "VikTV",
      extra: [{ name: "search", isRequired: false }]
    }
  ]
};

const builder = new addonBuilder(manifest);

let cache = [];
let lastFetch = 0;

function getAttribute(line, name) {
  const match = line.match(
    new RegExp(name + '="([^"]*)"', "i")
  );
  return match ? match[1] : "";
}

function makeId(title) {
  return "viktv:" + crypto
    .createHash("sha1")
    .update(title.toLowerCase().trim())
    .digest("hex")
    .slice(0, 16);
}

function normalize(title) {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

async function loadMovies() {
  if (cache.length && Date.now() - lastFetch < 60000) {
    return cache;
  }

  const response = await fetch(M3U_URL);

  if (!response.ok) {
    throw new Error("No se pudo leer la lista de GitHub");
  }

  const text = await response.text();
  const lines = text.split(/\r?\n/);

  const movies = new Map();
  let current = null;

  function saveCurrent() {
    if (!current || !current.title || !current.sources.length) {
      return;
    }

    const key = normalize(current.title);

    if (!movies.has(key)) {
      movies.set(key, {
        id: makeId(current.title),
        type: "movie",
        name: current.title,
        poster: current.poster || undefined,
        sources: []
      });
    }

    const movie = movies.get(key);

    if (!movie.poster && current.poster) {
      movie.poster = current.poster;
    }

    for (const source of current.sources) {
      if (!movie.sources.some(s => s.url === source.url)) {
        movie.sources.push(source);
      }
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      saveCurrent();

      const comma = line.indexOf(",");
      const title = comma >= 0
        ? line.slice(comma + 1).trim()
        : "Sin título";

      current = {
        title,
        poster: getAttribute(line, "tvg-logo"),
        sources: []
      };

      continue;
    }

    if (line.startsWith("#EXTVLCOPT:sub-file=")) {
      if (current) {
        const subtitle = line.substring(
          "#EXTVLCOPT:sub-file=".length
        );

        current.pendingSubtitle = subtitle;
      }
      continue;
    }

    if (line.startsWith("#")) continue;

    if (/^https?:\/\//i.test(line)) {
      if (!current) continue;

      try {
        new URL(line);

        current.sources.push({
          url: line,
          subtitle: current.pendingSubtitle || null
        });

        current.pendingSubtitle = null;
      } catch {
        continue;
      }
    }
  }

  saveCurrent();

  cache = Array.from(movies.values());
  lastFetch = Date.now();

  return cache;
}

function toMeta(movie) {
  return {
    id: movie.id,
    type: "movie",
    name: movie.name,
    poster: movie.poster,
    posterShape: "poster"
  };
}

builder.defineCatalogHandler(async ({ extra }) => {
  const movies = await loadMovies();

  const search = (extra?.search || "").toLowerCase();

  const filtered = search
    ? movies.filter(movie =>
        movie.name.toLowerCase().includes(search)
      )
    : movies;

  return {
    metas: filtered.map(toMeta)
  };
});

builder.defineMetaHandler(async ({ id }) => {
  const movies = await loadMovies();
  const movie = movies.find(item => item.id === id);

  if (!movie) return { meta: null };

  return {
    meta: {
      ...toMeta(movie),
      description: `${movie.sources.length} fuente(s) disponible(s)`
    }
  };
});

builder.defineStreamHandler(async ({ id }) => {
  const movies = await loadMovies();
  const movie = movies.find(item => item.id === id);

  if (!movie) return { streams: [] };

  return {
    streams: movie.sources.map((source, index) => {
      let host = "Fuente externa";

      try {
        host = new URL(source.url).hostname;
      } catch {}

      return {
        name: "VikTV",
        title: `Fuente ${index + 1} · ${host}`,
        url: source.url,
        ...(source.subtitle
          ? {
              subtitles: [{
                url: source.subtitle,
                lang: "spa"
              }]
            }
          : {})
      };
    })
  };
});

const addonInterface = builder.getInterface();

serveHTTP(addonInterface, {
  port: process.env.PORT || 7000,
  hostname: "0.0.0.0"
});

console.log("VikTV está funcionando");
console.log("Dirección: http://127.0.0.1:7000/manifest.json");
