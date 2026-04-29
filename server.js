import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const simulatorRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = simulatorRoot;
const port = Number.parseInt(process.env.OPENKNX_XML_NAVIGATOR_PORT || process.env.XML_NAVIGATOR_PORT || "4173", 10);
const navigatorConfig = resolveNavigatorConfig();
const helpArchiveCache = new Map();
const iconArchiveCache = new Map();
const knxprodSelectionSessions = new Map();
const uploadedSources = new Map();
const sourceDirectories = resolveSourceDirectories();
const configuredDefaultSource = resolveConfiguredDefaultSource();
const archiveMetadataXmlNames = new Set(["catalog.xml", "hardware.xml", "knx_master.xml"]);
const uploadBodyLimitBytes = 128 * 1024 * 1024;
const metadataXmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

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

function readNavigatorEnv(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function resolveNavigatorConfig() {
  return {
    appSubtitle: readNavigatorEnv(
      "OPENKNX_XML_NAVIGATOR_APP_SUBTITLE",
      "Interaktive Vorschau fuer expandierte XML mit Navigation, Bedingungen und Parameteransicht."
    ),
    appTitle: readNavigatorEnv("OPENKNX_XML_NAVIGATOR_APP_TITLE", "OpenKNX-XML-Navigator"),
    repositoryLabel: readNavigatorEnv("OPENKNX_XML_NAVIGATOR_REPOSITORY_LABEL", "GitHub"),
    repositoryUrl: readNavigatorEnv(
      "OPENKNX_XML_NAVIGATOR_REPOSITORY_URL",
      "https://github.com/kikakeule/OpenKNX-XML-Navigator"
    ),
    trademarkNotice: readNavigatorEnv(
      "OPENKNX_XML_NAVIGATOR_TRADEMARK_NOTICE",
      "KNX is a trademark of KNX Association. OpenKNX is an independent project and not affiliated with the OpenKNX-XML-Navigator."
    ),
  };
}

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

function normalizeArchiveEntryPath(file) {
  return normalizeRelativePath(String(file || "")).replace(/^\/+/, "");
}

function isSupportedUploadFileName(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  return [".xml", ".zip", ".knxprod"].includes(extension);
}

function isUploadedSourceReference(file) {
  return String(file || "").startsWith("upload:");
}

function readSourceXmlText(relativeFile) {
  if (isUploadedSourceReference(relativeFile)) {
    const uploadedSource = resolveUploadedSource(relativeFile);
    return uploadedSource.xmlText;
  }

  const absoluteFile = resolveWorkspaceXml(relativeFile);
  return fs.readFileSync(absoluteFile, "utf8");
}

function resolveUploadedSource(reference) {
  const normalizedReference = String(reference || "").trim();
  const uploadedSource = uploadedSources.get(normalizedReference);
  if (!uploadedSource) {
    throw new Error("Die hochgeladene Quelle ist nicht mehr verfuegbar.");
  }

  return uploadedSource;
}

function decodeUploadFileName(value) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  if (!rawValue) {
    return "upload.xml";
  }

  try {
    return decodeURIComponent(String(rawValue));
  } catch {
    return String(rawValue);
  }
}

function decodeRemoteHeaderFileName(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch {
    return String(value || "");
  }
}

function resolveRemoteFileName(sourceUrl, response) {
  const contentDisposition = response.headers.get("content-disposition") || "";
  const encodedMatch = contentDisposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (encodedMatch?.[1]) {
    const fileName = path.basename(decodeRemoteHeaderFileName(encodedMatch[1].trim().replace(/^"|"$/g, "")));
    if (fileName) {
      return fileName;
    }
  }

  const plainMatch = contentDisposition.match(/filename=("?)([^";]+)\1/i);
  if (plainMatch?.[2]) {
    const fileName = path.basename(plainMatch[2].trim());
    if (fileName) {
      return fileName;
    }
  }

  try {
    const parsedUrl = new URL(sourceUrl);
    const fileName = path.posix.basename(parsedUrl.pathname || "");
    if (fileName) {
      return fileName;
    }
  } catch {
    // Ignore invalid URL here, validation happens earlier.
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("xml")) {
    return "download.xml";
  }
  if (contentType.includes("zip")) {
    return "download.zip";
  }

  return "download.knxprod";
}

async function downloadRemoteSource(sourceUrl) {
  const normalizedSourceUrl = String(sourceUrl || "").trim();
  if (!normalizedSourceUrl) {
    throw new Error("Die Remote-Quelle ist leer.");
  }

  const parsedUrl = new URL(normalizedSourceUrl);
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new Error("Remote-Quellen muessen per HTTP oder HTTPS erreichbar sein.");
  }

  const response = await fetch(parsedUrl, {
    headers: {
      "User-Agent": "OpenKNX-XML-Navigator",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Die Remote-Quelle konnte nicht geladen werden (${response.status}).`);
  }

  const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength > uploadBodyLimitBytes) {
    throw new Error("Die Remote-Datei ist zu gross.");
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) {
    throw new Error("Die Remote-Datei ist leer.");
  }
  if (body.length > uploadBodyLimitBytes) {
    throw new Error("Die Remote-Datei ist zu gross.");
  }

  const fileName = resolveRemoteFileName(normalizedSourceUrl, response);
  if (!isSupportedUploadFileName(fileName)) {
    throw new Error("Remote unterstuetzt werden XML-, ZIP- und KNXPROD-Dateien.");
  }

  return {
    body,
    fileName,
  };
}

function createUploadSourceLabel(uploadName, entryName) {
  const normalizedUploadName = path.basename(String(uploadName || "upload.xml"));
  const normalizedEntryName = path.posix.basename(normalizeArchiveEntryPath(entryName));
  if (!normalizedEntryName || normalizedEntryName.toLowerCase() === normalizedUploadName.toLowerCase()) {
    return normalizedUploadName;
  }

  return `${normalizedUploadName} [${normalizedEntryName}]`;
}

function trimUtf8Bom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  return value === undefined || value === null ? [] : [value];
}

function parseXmlMetadata(text) {
  return metadataXmlParser.parse(trimUtf8Bom(text || ""));
}

function readArchiveEntryText(entry) {
  return trimUtf8Bom(entry.getData().toString("utf8"));
}

function getKnxApplicationProgramNode(parsedXml) {
  return parsedXml?.KNX?.ManufacturerData?.Manufacturer?.ApplicationPrograms?.ApplicationProgram || null;
}

function collectKnxprodApplicationEntries(entries) {
  const applicationEntries = new Map();

  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }

    const normalizedEntryName = normalizeArchiveEntryPath(entry.entryName);
    const extension = path.posix.extname(normalizedEntryName).toLowerCase();
    const baseName = path.posix.basename(normalizedEntryName).toLowerCase();
    if (extension !== ".xml" || archiveMetadataXmlNames.has(baseName)) {
      continue;
    }

    applicationEntries.set(path.posix.basename(normalizedEntryName, ".xml"), entry);
  }

  return applicationEntries;
}

function parseKnxprodApplicationLanguages(entry) {
  const xmlText = readArchiveEntryText(entry);
  const parsedXml = parseXmlMetadata(xmlText);
  const appNode = getKnxApplicationProgramNode(parsedXml);
  const appId = String(appNode?.Id || "").trim();
  const defaultLanguage = String(appNode?.DefaultLanguage || "").trim();
  const languages = [];

  for (const languageNode of asArray(parsedXml?.KNX?.ManufacturerData?.Manufacturer?.Languages?.Language)) {
    const identifier = String(languageNode?.Identifier || "").trim();
    const translationUnits = asArray(languageNode?.TranslationUnit);
    const hasMatchingTranslationUnit = !appId || translationUnits.some((translationUnit) => String(translationUnit?.RefId || "").trim() === appId);
    if (identifier && hasMatchingTranslationUnit && !languages.includes(identifier)) {
      languages.push(identifier);
    }
  }

  if (defaultLanguage && !languages.includes(defaultLanguage)) {
    languages.unshift(defaultLanguage);
  }

  return {
    defaultLanguage,
    languages,
  };
}

function buildKnxprodProductLabel(productNode) {
  const orderNumber = String(productNode?.OrderNumber || "").trim();
  const productText = String(productNode?.Text || "").trim();
  const parts = [];
  if (orderNumber) {
    parts.push(orderNumber);
  }
  if (productText && productText !== orderNumber) {
    parts.push(productText);
  }

  return {
    orderNumber,
    productLabel: parts.join(" - ") || productText || orderNumber || "Produkt",
    productText,
  };
}

function createKnxprodSourceLabel(uploadName, selectedProduct, languageIdentifier) {
  const normalizedUploadName = path.basename(String(uploadName || "upload.knxprod"));
  const descriptor = selectedProduct?.productLabel || selectedProduct?.productText || selectedProduct?.applicationProgramId || "";
  if (!descriptor) {
    return normalizedUploadName;
  }

  const languageSuffix = languageIdentifier ? ` | ${languageIdentifier}` : "";
  return `${normalizedUploadName} [${descriptor}${languageSuffix}]`;
}

function createKnxprodSelectionSession(fileName, body) {
  const archive = new AdmZip(body);
  const archiveEntries = archive.getEntries();
  const applicationEntries = collectKnxprodApplicationEntries(archiveEntries);
  const hardwareEntry = findArchiveEntry(archiveEntries, "", "Hardware.xml");
  if (!hardwareEntry) {
    throw new Error("Die KNXPROD-Datei enthaelt kein Hardware.xml.");
  }

  const hardwareRoot = parseXmlMetadata(readArchiveEntryText(hardwareEntry));
  const hardwareNodes = asArray(hardwareRoot?.KNX?.ManufacturerData?.Manufacturer?.Hardware?.Hardware);
  const products = [];

  for (const hardwareNode of hardwareNodes) {
    const hardware2ProgramNodes = asArray(hardwareNode?.Hardware2Programs?.Hardware2Program);
    const applicationProgramId = hardware2ProgramNodes
      .map((hardware2ProgramNode) => String(hardware2ProgramNode?.ApplicationProgramRef?.RefId || "").trim())
      .find(Boolean);
    if (!applicationProgramId) {
      continue;
    }

    const appEntry = applicationEntries.get(applicationProgramId);
    if (!appEntry) {
      continue;
    }

    const languageMetadata = parseKnxprodApplicationLanguages(appEntry);
    for (const productNode of asArray(hardwareNode?.Products?.Product)) {
      const { orderNumber, productLabel, productText } = buildKnxprodProductLabel(productNode);
      products.push({
        applicationProgramId,
        defaultLanguage: languageMetadata.defaultLanguage || languageMetadata.languages[0] || "",
        entryName: normalizeArchiveEntryPath(appEntry.entryName),
        languages: languageMetadata.languages,
        orderNumber,
        productId: String(productNode?.Id || applicationProgramId).trim(),
        productLabel,
        productText,
      });
    }
  }

  if (products.length === 0) {
    throw new Error("Im KNXPROD wurde kein Produkt mit ApplicationProgram gefunden.");
  }

  const sessionId = `upload-session:${randomUUID()}`;
  const session = {
    body,
    fileName: path.basename(String(fileName || "upload.knxprod")),
    products,
    sessionId,
  };
  knxprodSelectionSessions.set(sessionId, session);
  return session;
}

function resolveKnxprodSelectionSession(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  const session = knxprodSelectionSessions.get(normalizedSessionId);
  if (!session) {
    throw new Error("Die KNXPROD-Auswahl ist nicht mehr verfuegbar.");
  }

  return session;
}

function shouldPromptForKnxprodSelection(session) {
  return session.products.length > 1 || session.products.some((product) => (product.languages || []).length > 1);
}

function buildKnxprodSelectionPayload(session) {
  return {
    selectionRequired: true,
    sessionId: session.sessionId,
    sourceKind: "knxprod",
    sourceLabel: session.fileName,
    products: session.products.map((product) => ({
      applicationProgramId: product.applicationProgramId,
      defaultLanguage: product.defaultLanguage,
      languages: product.languages,
      orderNumber: product.orderNumber,
      productId: product.productId,
      productLabel: product.productLabel,
      productText: product.productText,
    })),
  };
}

function buildUploadedSourcePayload(uploadedSource) {
  return {
    helpTexts: uploadedSource.helpTexts || {},
    iconCount: uploadedSource.icons?.size || 0,
    languageId: uploadedSource.selectedLanguage || "",
    resolvedEntryName: uploadedSource.resolvedEntryName || "",
    sourceId: uploadedSource.sourceId,
    sourceLabel: uploadedSource.sourceLabel,
    xmlText: uploadedSource.xmlText,
  };
}

function finalizeKnxprodSelection(sessionId, productId, languageId) {
  const session = resolveKnxprodSelectionSession(sessionId);
  const selectedProduct = session.products.find((product) => product.productId === productId)
    || session.products.find((product) => product.applicationProgramId === productId)
    || session.products[0];
  if (!selectedProduct) {
    throw new Error("Es konnte kein Produkt fuer die KNXPROD-Datei ausgewaehlt werden.");
  }

  const archive = new AdmZip(session.body);
  const xmlEntry = archive.getEntry(selectedProduct.entryName);
  if (!xmlEntry) {
    throw new Error("Die ApplicationProgram-XML fuer das ausgewaehlte Produkt wurde nicht gefunden.");
  }

  const selectedLanguage = String(languageId || selectedProduct.defaultLanguage || selectedProduct.languages[0] || "").trim();
  const uploadedSource = {
    xmlText: readArchiveEntryText(xmlEntry),
    helpTexts: {},
    icons: new Map(),
    resolvedEntryName: normalizeArchiveEntryPath(xmlEntry.entryName),
    selectedLanguage,
    sourceId: `upload:${randomUUID()}`,
    sourceLabel: createKnxprodSourceLabel(session.fileName, selectedProduct, selectedLanguage),
  };

  uploadedSources.set(uploadedSource.sourceId, uploadedSource);
  return uploadedSource;
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
  if (isUploadedSourceReference(relativeFile)) {
    return resolveUploadedSource(relativeFile).helpTexts || {};
  }

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
  if (isUploadedSourceReference(relativeFile)) {
    return resolveUploadedSource(relativeFile).icons || new Map();
  }

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

  if (isUploadedSourceReference(relativeFile)) {
    return null;
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

function readRequestBody(request, maxBytes = uploadBodyLimitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let isCompleted = false;

    const fail = (error) => {
      if (isCompleted) {
        return;
      }

      isCompleted = true;
      reject(error);
    };

    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(new Error("Die hochgeladene Datei ist zu gross."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      if (isCompleted) {
        return;
      }

      isCompleted = true;
      resolve(Buffer.concat(chunks));
    });

    request.on("error", (error) => {
      if (error.message === "Die hochgeladene Datei ist zu gross.") {
        fail(error);
        return;
      }

      if (!isCompleted) {
        fail(error);
      }
    });
  });
}

function pickArchiveXmlEntry(entries) {
  const xmlEntries = entries.filter((entry) => !entry.isDirectory && path.posix.extname(entry.entryName).toLowerCase() === ".xml");
  if (xmlEntries.length === 0) {
    return null;
  }

  const rankXmlEntry = (entry) => {
    const normalizedEntryName = normalizeArchiveEntryPath(entry.entryName).toLowerCase();
    const baseName = path.posix.basename(normalizedEntryName);
    if (archiveMetadataXmlNames.has(baseName)) {
      return 100;
    }
    if (normalizedEntryName.endsWith(".debug.xml") && !normalizedEntryName.endsWith(".appl.debug.xml") && !normalizedEntryName.includes("-release")) {
      return 0;
    }
    if (normalizedEntryName.endsWith(".debug.xml") && !normalizedEntryName.endsWith(".appl.debug.xml")) {
      return 1;
    }
    if (normalizedEntryName.endsWith(".appl.debug.xml") && !normalizedEntryName.includes("-release")) {
      return 2;
    }
    if (normalizedEntryName.endsWith(".appl.debug.xml")) {
      return 3;
    }
    return 4;
  };

  return xmlEntries.sort((left, right) => {
    const rankDelta = rankXmlEntry(left) - rankXmlEntry(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }

    const sizeDelta = (right.header?.size || right.getData().length || 0) - (left.header?.size || left.getData().length || 0);
    if (sizeDelta !== 0) {
      return sizeDelta;
    }

    return normalizeArchiveEntryPath(left.entryName).localeCompare(normalizeArchiveEntryPath(right.entryName));
  })[0];
}

function resolveArchiveBaggageRoot(entryName) {
  const normalizedEntry = normalizeArchiveEntryPath(entryName);
  const entryDirectory = path.posix.dirname(normalizedEntry);
  const fileName = path.posix.basename(normalizedEntry);
  const baggageBaseName = fileName
    .replace(/(\.appl)?\.debug\.xml$/i, "")
    .replace(/\.xml$/i, "");

  return normalizeArchiveEntryPath(path.posix.join(entryDirectory === "." ? "" : entryDirectory, `${baggageBaseName}.baggages`));
}

function findArchiveEntry(entries, rootPath, fileName) {
  const normalizedRootPath = normalizeArchiveEntryPath(rootPath);
  const expectedName = String(fileName || "").toLowerCase();
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }

    const normalizedEntryName = normalizeArchiveEntryPath(entry.entryName);
    if (path.posix.basename(normalizedEntryName).toLowerCase() !== expectedName) {
      continue;
    }

    if (!normalizedRootPath || normalizedEntryName.startsWith(`${normalizedRootPath}/`)) {
      return entry;
    }
  }

  return null;
}

function extractHelpTextsFromArchive(entries, baggageRoot) {
  const helpArchiveEntry = findArchiveEntry(entries, baggageRoot, "Help_de.zip");
  if (!helpArchiveEntry) {
    return {};
  }

  const helpArchive = new AdmZip(helpArchiveEntry.getData());
  const helpTexts = Object.create(null);
  for (const entry of helpArchive.getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith(".txt")) {
      continue;
    }

    const helpId = path.posix.basename(entry.entryName, ".txt");
    helpTexts[helpId] = entry
      .getData()
      .toString("utf8")
      .replace(/\r\n/g, "\n")
      .trim();
  }

  return helpTexts;
}

function extractIconsFromArchive(entries, baggageRoot) {
  const icons = new Map();
  const iconArchiveEntry = findArchiveEntry(entries, baggageRoot, "Icons.zip");
  if (iconArchiveEntry) {
    const iconArchive = new AdmZip(iconArchiveEntry.getData());
    for (const entry of iconArchive.getEntries()) {
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
  }

  const normalizedBaggageRoot = normalizeArchiveEntryPath(baggageRoot);
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }

    const normalizedEntryName = normalizeArchiveEntryPath(entry.entryName);
    if (!normalizedBaggageRoot || !normalizedEntryName.startsWith(`${normalizedBaggageRoot}/`)) {
      continue;
    }

    const extension = path.posix.extname(normalizedEntryName).toLowerCase();
    if (![".png", ".svg", ".webp"].includes(extension)) {
      continue;
    }

    const iconName = path.posix.basename(normalizedEntryName, extension).toLowerCase();
    if (!icons.has(iconName)) {
      icons.set(iconName, {
        body: entry.getData(),
        contentType: contentTypes[extension] || "application/octet-stream",
      });
    }
  }

  return icons;
}

function parseUploadedSource(fileName, body) {
  const normalizedFileName = path.basename(String(fileName || "upload.xml"));
  const extension = path.extname(normalizedFileName).toLowerCase();

  if (!isSupportedUploadFileName(normalizedFileName)) {
    throw new Error("Unterstuetzt werden XML-, ZIP- und KNXPROD-Dateien.");
  }

  if (extension === ".xml") {
    const sourceId = `upload:${randomUUID()}`;
    const xmlText = trimUtf8Bom(body.toString("utf8"));
    const uploadedSource = {
      xmlText,
      helpTexts: {},
      icons: new Map(),
      sourceId,
      sourceLabel: normalizedFileName,
    };
    uploadedSources.set(sourceId, uploadedSource);
    return uploadedSource;
  }

  if (extension === ".knxprod") {
    const session = createKnxprodSelectionSession(normalizedFileName, body);
    if (shouldPromptForKnxprodSelection(session)) {
      return buildKnxprodSelectionPayload(session);
    }

    return finalizeKnxprodSelection(
      session.sessionId,
      session.products[0]?.productId || session.products[0]?.applicationProgramId || "",
      session.products[0]?.defaultLanguage || session.products[0]?.languages?.[0] || ""
    );
  }

  const archive = new AdmZip(body);
  const archiveEntries = archive.getEntries();
  const xmlEntry = pickArchiveXmlEntry(archiveEntries);
  if (!xmlEntry) {
    throw new Error("Im Archiv wurde keine passende XML-Datei gefunden.");
  }

  const baggageRoot = resolveArchiveBaggageRoot(xmlEntry.entryName);
  const sourceId = `upload:${randomUUID()}`;
  const uploadedSource = {
    xmlText: trimUtf8Bom(xmlEntry.getData().toString("utf8")),
    helpTexts: extractHelpTextsFromArchive(archiveEntries, baggageRoot),
    icons: extractIconsFromArchive(archiveEntries, baggageRoot),
    resolvedEntryName: normalizeArchiveEntryPath(xmlEntry.entryName),
    sourceId,
    sourceLabel: createUploadSourceLabel(normalizedFileName, xmlEntry.entryName),
  };

  uploadedSources.set(sourceId, uploadedSource);
  return uploadedSource;
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

  if (requestUrl.pathname === "/api/config") {
    sendJson(response, 200, navigatorConfig);
    return;
  }

  if (requestUrl.pathname === "/api/xml") {
    const file = requestUrl.searchParams.get("file");
    try {
      sendText(response, 200, readSourceXmlText(file), contentTypes[".xml"]);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/upload-source") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "POST required." });
      return;
    }

    readRequestBody(request)
      .then((body) => {
        const fileName = decodeUploadFileName(request.headers["x-file-name"]);
        const uploadedSource = parseUploadedSource(fileName, body);
        sendJson(response, 200, uploadedSource.selectionRequired ? uploadedSource : buildUploadedSourcePayload(uploadedSource));
      })
      .catch((error) => {
        const message = error?.message === "Die hochgeladene Datei ist zu gross."
          ? error.message
          : error?.message || "Die Datei konnte nicht verarbeitet werden.";
        sendJson(response, 400, { error: message });
      });
    return;
  }

  if (requestUrl.pathname === "/api/upload-source/resolve") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "POST required." });
      return;
    }

    readRequestBody(request)
      .then((body) => {
        const payload = JSON.parse(body.toString("utf8") || "{}");
        const uploadedSource = finalizeKnxprodSelection(payload.sessionId, payload.productId, payload.languageId);
        sendJson(response, 200, buildUploadedSourcePayload(uploadedSource));
      })
      .catch((error) => {
        sendJson(response, 400, { error: error?.message || "Die KNXPROD-Auswahl konnte nicht geladen werden." });
      });
    return;
  }

  if (requestUrl.pathname === "/api/import-remote") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "POST required." });
      return;
    }

    readRequestBody(request, 64 * 1024)
      .then(async (body) => {
        const payload = JSON.parse(body.toString("utf8") || "{}");
        const remoteSource = await downloadRemoteSource(payload.url || payload.sourceUrl || payload.source || "");
        const uploadedSource = parseUploadedSource(remoteSource.fileName, remoteSource.body);
        sendJson(response, 200, uploadedSource.selectionRequired ? uploadedSource : buildUploadedSourcePayload(uploadedSource));
      })
      .catch((error) => {
        sendJson(response, 400, { error: error?.message || "Die Remote-Quelle konnte nicht geladen werden." });
      });
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
  console.log(`OpenKNX-XML-Navigator listening on http://localhost:${port}`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Source directories: ${sourceDirectories.join(", ") || "<none>"}`);
  console.log(`Configured default source: ${configuredDefaultSource || "<auto>"}`);
});