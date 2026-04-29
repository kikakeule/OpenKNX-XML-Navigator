import AdmZip from "adm-zip";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const simulatorRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = simulatorRoot;
const port = Number.parseInt(process.env.OPENKNX_XML_NAVIGATOR_PORT || process.env.XML_NAVIGATOR_PORT || "4173", 10);
const helpArchiveCache = new Map();
const iconArchiveCache = new Map();
const sourceDirectories = resolveSourceDirectories();
const configuredDefaultSource = resolveConfiguredDefaultSource();

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendBinary(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Length": body.length,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function normalizeRelativePath(file) {
  return file.replace(/\\/g, "/");
}

function resolveSourceDirectories() {
  const configured = String(process.env.OPENKNX_XML_NAVIGATOR_SOURCE_DIRS || process.env.XML_NAVIGATOR_SOURCE_DIRS || "")
    .split(";")
    .map((segment) => normalizeRelativePath(segment.trim()).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

  const candidates = configured.length > 0 ? configured : ["examples", "data"];
  const uniqueDirectories = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    uniqueDirectories.push(candidate);
  }

  return uniqueDirectories;
}

function resolveConfiguredDefaultSource() {
  const configured = normalizeRelativePath(
    String(process.env.OPENKNX_XML_NAVIGATOR_DEFAULT_SOURCE || process.env.XML_NAVIGATOR_DEFAULT_SOURCE || "examples/LedDimmerAB.debug.xml").trim()
  );
  return configured.replace(/^\/+/, "");
}

function listXmlSources() {
  const files = [];
  const seenFiles = new Set();

  for (const sourceDirectory of sourceDirectories) {
    const absoluteDirectory = path.join(workspaceRoot, sourceDirectory);
    if (!fs.existsSync(absoluteDirectory)) {
      continue;
    }

    for (const relativeFile of collectXmlFiles(absoluteDirectory, sourceDirectory)) {
      if (seenFiles.has(relativeFile)) {
        continue;
      }

      seenFiles.add(relativeFile);
      files.push(relativeFile);
    }
  }

  const priority = (file) => {
    if (file.endsWith(".debug.xml") && !file.endsWith(".appl.debug.xml") && !file.includes("-Release")) {
      return 0;
    }
    if (file.endsWith(".debug.xml") && !file.endsWith(".appl.debug.xml")) {
      return 1;
    }
    if (file.endsWith(".appl.debug.xml") && !file.includes("-Release")) {
      return 2;
    }
    if (file.endsWith(".appl.debug.xml")) {
      return 3;
    }
    if (file.endsWith(".xml") && !file.includes("-Release")) {
      return 4;
    }
    return 5;
  };

  return files.sort((left, right) => {
    const priorityDelta = priority(left) - priority(right);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.localeCompare(right);
  });
}

function collectXmlFiles(absoluteDirectory, relativeDirectory) {
  const files = [];

  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = normalizeRelativePath(path.posix.join(relativeDirectory, entry.name));

    if (entry.isDirectory()) {
      files.push(...collectXmlFiles(absolutePath, relativePath));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".xml") || entry.name.endsWith(".knxprod")) {
      continue;
    }

    files.push(relativePath);
  }

  return files;
}

function findFileRecursive(rootDir, fileName) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  const pending = [rootDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (entry.name === fileName) {
        return absolutePath;
      }
    }
  }

  return null;
}

function resolveDefaultSource(sources) {
  if (configuredDefaultSource && sources.includes(configuredDefaultSource)) {
    return configuredDefaultSource;
  }

  return sources[0] || null;
}

function resolveWorkspaceXml(relativeFile) {
  const normalized = normalizeRelativePath(relativeFile || "").replace(/^\/+/, "");
  if (!normalized.toLowerCase().endsWith(".xml")) {
    throw new Error("Only XML files are supported.");
  }

  const absoluteFile = path.resolve(workspaceRoot, normalized);
  const relativeToWorkspace = path.relative(workspaceRoot, absoluteFile);

  if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
    throw new Error("The requested XML file is outside the workspace.");
  }

  return absoluteFile;
}

function resolveBaggageRoot(relativeFile) {
  const normalized = normalizeRelativePath(relativeFile || "");
  const absoluteFile = resolveWorkspaceXml(normalized);
  const xmlFileName = path.basename(normalized);
  const baggageBaseName = xmlFileName
    .replace(/(\.appl)?\.debug\.xml$/i, "")
    .replace(/\.xml$/i, "");

  return path.join(path.dirname(absoluteFile), `${baggageBaseName}.baggages`);
}

function findBaggageArchive(relativeFile, archiveName) {
  return findFileRecursive(resolveBaggageRoot(relativeFile), archiveName);
}

function loadHelpTexts(relativeFile) {
  const archivePath = findBaggageArchive(relativeFile, "Help_de.zip");
  if (!archivePath) {
    return {};
  }

  if (helpArchiveCache.has(archivePath)) {
    return helpArchiveCache.get(archivePath);
  }

  const zip = new AdmZip(archivePath);
  const helps = Object.create(null);

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith(".txt")) {
      continue;
    }

    const helpId = path.posix.basename(entry.entryName, ".txt");
    helps[helpId] = entry
      .getData()
      .toString("utf8")
      .replace(/\r\n/g, "\n")
      .trim();
  }

  helpArchiveCache.set(archivePath, helps);
  return helps;
}

function loadIcons(relativeFile) {
  const archivePath = findBaggageArchive(relativeFile, "Icons.zip");
  if (!archivePath) {
    return new Map();
  }

  if (iconArchiveCache.has(archivePath)) {
    return iconArchiveCache.get(archivePath);
  }

  const zip = new AdmZip(archivePath);
  const icons = new Map();

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const extension = path.posix.extname(entry.entryName).toLowerCase();
    if (![".png", ".svg", ".webp"].includes(extension)) {
      continue;
    }

    const iconName = path.posix.basename(entry.entryName, extension).toLowerCase();
    if (!icons.has(iconName)) {
      icons.set(iconName, {
        body: entry.getData(),
        contentType: contentTypes[extension] || "application/octet-stream",
      });
    }
  }

  iconArchiveCache.set(archivePath, icons);
  return icons;
}

function loadIcon(relativeFile, iconName) {
  const normalizedName = String(iconName || "").trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  const icons = loadIcons(relativeFile);
  if (icons.has(normalizedName)) {
    return icons.get(normalizedName);
  }

  for (const [candidateName, candidate] of icons.entries()) {
    if (candidateName.startsWith(`${normalizedName}-`)) {
      return candidate;
    }
  }

  for (const extension of [".png", ".svg", ".webp"]) {
    const fileName = `${normalizedName}${extension}`;
    const assetPath = findFileRecursive(resolveBaggageRoot(relativeFile), fileName);
    if (!assetPath) {
      continue;
    }

    return {
      body: fs.readFileSync(assetPath),
      contentType: contentTypes[extension] || "application/octet-stream",
    };
  }

  return null;
}

function serveStaticFile(requestPath, response) {
  const targetPath = requestPath === "/" ? "/index.html" : requestPath;
  const absoluteFile = path.resolve(simulatorRoot, `.${targetPath}`);
  const relativeToSimulator = path.relative(simulatorRoot, absoluteFile);
  if (relativeToSimulator.startsWith("..") || path.isAbsolute(relativeToSimulator)) {
    sendText(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  fs.readFile(absoluteFile, (error, data) => {
    if (error) {
      const statusCode = error.code === "ENOENT" ? 404 : 500;
      const message = error.code === "ENOENT" ? "Not found" : "Failed to read file";
      sendText(response, statusCode, message, "text/plain; charset=utf-8");
      return;
    }

    const extension = path.extname(absoluteFile).toLowerCase();
    response.writeHead(200, {
      "Content-Length": data.length,
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === "/api/sources") {
    const sources = listXmlSources();
    sendJson(response, 200, {
      defaultSource: resolveDefaultSource(sources),
      sources,
    });
    return;
  }

  if (requestUrl.pathname === "/api/xml") {
    const file = requestUrl.searchParams.get("file");
    try {
      const absoluteFile = resolveWorkspaceXml(file);
      fs.readFile(absoluteFile, "utf8", (error, body) => {
        if (error) {
          const statusCode = error.code === "ENOENT" ? 404 : 500;
          const message = error.code === "ENOENT" ? "XML file not found." : "Failed to read XML file.";
          sendJson(response, statusCode, { error: message });
          return;
        }

        sendText(response, 200, body, contentTypes[".xml"]);
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/help") {
    const file = requestUrl.searchParams.get("file");
    try {
      const helps = loadHelpTexts(file);
      sendJson(response, 200, { helps });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/icon") {
    const file = requestUrl.searchParams.get("file");
    const icon = requestUrl.searchParams.get("icon");
    try {
      const iconAsset = loadIcon(file, icon);
      if (!iconAsset) {
        sendJson(response, 404, { error: "Icon not found." });
        return;
      }

      sendBinary(response, 200, iconAsset.body, iconAsset.contentType);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  serveStaticFile(requestUrl.pathname, response);
});

server.listen(port, () => {
  console.log(`OpenKNX XML Navigator listening on http://localhost:${port}`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Source directories: ${sourceDirectories.join(", ") || "<none>"}`);
  console.log(`Configured default source: ${configuredDefaultSource || "<auto>"}`);
});