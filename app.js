import {
  buildSimulatorModel,
  describeField,
  describeObject,
  deriveRuntimeState,
  materializeNode,
  materializeNodes,
  resolveBreadcrumbs,
  resolveNodePath,
  resolveTitle,
} from "./model.js";

const HIDDEN_PARAMETER_NAMES = new Set([
  "BASE_Diagnose",
  "BASE_Dummy",
  "BASE_HeartbeatExtended",
  "BASE_InternalTime",
  "BASE_ShowModuleSyncButton",
  "BASE_Watchdog",
  "LED_DisplayNumChannels",
]);
const HIDDEN_PARAMETER_PATTERNS = [/^LED_HardwareVariant(?:Has|Can)/];

const state = {
  defaultSource: "",
  derivedState: {},
  explicitHelpContext: "",
  explicitHelpLabel: "",
  helpTexts: {},
  isSourcePanelCollapsed: true,
  localSourceName: "",
  model: null,
  selectedNodeId: null,
  selectedSource: "",
  sourceOrigin: "server",
  sources: [],
  userState: {},
  viewMode: "parameter",
  visibleNodeIds: new Set(),
  visibleRoots: [],
};

const elements = {
  appStatus: document.querySelector("#app-status"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  defaultButton: document.querySelector("#load-default-button"),
  helpContent: document.querySelector("#help-content"),
  helpContext: document.querySelector("#help-context"),
  helpTitle: document.querySelector("#help-title"),
  navigationTree: document.querySelector("#navigation-tree"),
  pageContent: document.querySelector("#page-content"),
  pageMeta: document.querySelector("#page-meta"),
  pageTitle: document.querySelector("#page-title"),
  reloadButton: document.querySelector("#reload-button"),
  sourceFile: document.querySelector("#source-file"),
  sourceForm: document.querySelector("#source-form"),
  sourceSelect: document.querySelector("#source-select"),
  sourceSummary: document.querySelector("#source-summary"),
  statsText: document.querySelector("#stats-text"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  tabChannelsCount: document.querySelector("#tab-channels-count"),
  tabObjectsCount: document.querySelector("#tab-objects-count"),
  tabParametersCount: document.querySelector("#tab-parameters-count"),
  toggleSourcePanel: document.querySelector("#toggle-source-panel"),
  warningBanner: document.querySelector("#warning-banner"),
};

bootstrap().catch((error) => {
  setStatus(error.message, true);
});

async function bootstrap() {
  bindEvents();
  setSourcePanelCollapsed(state.isSourcePanelCollapsed);
  updateSourceSummary();
  await refreshSources();
  if (state.defaultSource) {
    await loadDefaultSource();
  } else if (elements.sourceSelect.value) {
    await loadSelectedSource();
  } else {
    setStatus("Keine XML-Dateien verfuegbar. Lade eine lokale XML-Datei oder konfiguriere eine Default-Quelle.", true);
  }
}

function bindEvents() {
  elements.sourceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loadSelectedSource();
  });

  elements.reloadButton.addEventListener("click", async () => {
    await refreshSources();
  });

  elements.toggleSourcePanel.addEventListener("click", () => {
    setSourcePanelCollapsed(!state.isSourcePanelCollapsed);
  });

  elements.defaultButton.addEventListener("click", async () => {
    await loadDefaultSource();
  });

  elements.sourceFile.addEventListener("change", async (event) => {
    await handleLocalSourceSelection(event);
  });

  for (const tabButton of elements.tabButtons) {
    tabButton.addEventListener("click", () => {
      state.viewMode = tabButton.dataset.view || "parameter";
      render();
    });
  }
}

async function refreshSources() {
  setStatus("XML-Quellen werden gesucht.");
  const response = await fetch("/api/sources", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Die XML-Quellen konnten nicht gelesen werden.");
  }

  const payload = await response.json();
  state.sources = payload.sources || [];
  state.defaultSource = payload.defaultSource || "";

  const previousSelection = state.sourceOrigin === "server" && state.selectedSource ? state.selectedSource : elements.sourceSelect.value;
  elements.sourceSelect.innerHTML = "";

  for (const source of state.sources) {
    const option = document.createElement("option");
    option.value = source;
    option.textContent = source;
    elements.sourceSelect.append(option);
  }

  const nextSelection = state.sources.includes(previousSelection)
    ? previousSelection
    : state.defaultSource || state.sources[0] || "";

  elements.sourceSelect.value = nextSelection;
  elements.sourceSelect.disabled = state.sources.length === 0;
  elements.defaultButton.disabled = !state.defaultSource;
  updateSourceSummary();

  if (state.sources.length > 0 || state.model) {
    clearStatus();
  } else {
    setStatus("Keine XML-Dateien verfuegbar. Lade eine lokale XML-Datei oder konfiguriere eine Default-Quelle.", true);
  }
}

async function loadSelectedSource() {
  const source = elements.sourceSelect.value;
  if (!source) {
    setStatus("Bitte zuerst eine XML-Datei auswaehlen.", true);
    return;
  }

  await loadServerSource(source);
}

async function loadDefaultSource() {
  if (!state.defaultSource) {
    setStatus("Es ist keine Default-XML konfiguriert.", true);
    return;
  }

  if (state.sources.includes(state.defaultSource)) {
    elements.sourceSelect.value = state.defaultSource;
  }

  await loadServerSource(state.defaultSource);
}

async function loadServerSource(source) {
  if (!source) {
    setStatus("Bitte zuerst eine XML-Datei auswaehlen.", true);
    return;
  }

  setStatus(`Lade ${source} ...`);
  const [xmlResponse, helpResponse] = await Promise.all([
    fetch(`/api/xml?file=${encodeURIComponent(source)}`, { cache: "no-store" }),
    fetch(`/api/help?file=${encodeURIComponent(source)}`, { cache: "no-store" }),
  ]);

  if (!xmlResponse.ok) {
    const message = await safeErrorMessage(xmlResponse);
    throw new Error(message || "Die XML-Datei konnte nicht geladen werden.");
  }

  const xmlText = await xmlResponse.text();
  const helpPayload = helpResponse.ok ? await helpResponse.json() : { helps: {} };

  applyLoadedXml(xmlText, {
    helpTexts: helpPayload.helps || {},
    selectedSource: source,
    sourceOrigin: "server",
  });
}

async function handleLocalSourceSelection(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    setStatus(`Lade ${file.name} ...`);
    const xmlText = await file.text();
    applyLoadedXml(xmlText, {
      helpTexts: {},
      localSourceName: file.name,
      selectedSource: "",
      sourceOrigin: "local",
    });
  } finally {
    event.target.value = "";
  }
}

function applyLoadedXml(xmlText, options) {
  const nextOptions = options || {};

  state.localSourceName = nextOptions.localSourceName || "";
  state.selectedSource = nextOptions.selectedSource || "";
  state.sourceOrigin = nextOptions.sourceOrigin || "server";
  state.model = buildSimulatorModel(xmlText);
  state.helpTexts = nextOptions.helpTexts || {};
  state.userState = { ...state.model.initialState };
  state.explicitHelpContext = "";
  state.explicitHelpLabel = "";
  updateDerivedState();
  state.selectedNodeId = pickInitialNodeId();
  updateSourceSummary();
  render();
  clearStatus();
}

function setSourcePanelCollapsed(isCollapsed) {
  state.isSourcePanelCollapsed = isCollapsed;
  elements.sourceForm.classList.toggle("is-collapsed", isCollapsed);
  elements.toggleSourcePanel.textContent = isCollapsed ? "Ausklappen" : "Minimieren";
  elements.toggleSourcePanel.setAttribute("aria-expanded", String(!isCollapsed));
}

function updateSourceSummary() {
  const fullLabel = resolveSourceSummaryLabel();
  const shortLabel = fullLabel ? extractFileName(fullLabel) : "Noch keine XML ausgewaehlt";
  elements.sourceSummary.textContent = shortLabel;

  if (fullLabel) {
    elements.sourceSummary.title = fullLabel;
  } else {
    elements.sourceSummary.removeAttribute("title");
  }
}

function resolveSourceSummaryLabel() {
  if (state.sourceOrigin === "local" && state.localSourceName) {
    return state.localSourceName;
  }

  return state.selectedSource || elements.sourceSelect.value || state.defaultSource || "";
}

function extractFileName(path) {
  const segments = String(path || "").split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || "";
}

function updateDerivedState() {
  state.derivedState = deriveRuntimeState(state.model, state.userState);
  state.visibleRoots = getVisibleRootChannels(materializeNodes(state.model.roots, state.derivedState));
  state.visibleNodeIds = collectVisibleNodeIds(state.visibleRoots);
}

function pickInitialNodeId() {
  const entries = buildNavigationEntries(state.visibleRoots);
  if (entries.length === 0) {
    return null;
  }

  let current = entries[0];
  while (current.children && current.children.length > 0) {
    current = current.children[0];
  }
  return current.labelNodeId;
}

function render() {
  syncSelectedNode();
  renderWarnings();
  renderTabs();
  renderStats();
  renderNavigation();
  renderContent();
  renderHelpPanel();
}

function renderWarnings() {
  if (!state.model || state.model.warnings.length === 0) {
    elements.warningBanner.classList.add("hidden");
    elements.warningBanner.textContent = "";
    return;
  }

  elements.warningBanner.classList.remove("hidden");
  elements.warningBanner.textContent = state.model.warnings.join(" ");
}

function renderTabs() {
  const parameterCount = countVisibleParametersForSelection();
  const objectCount = collectVisibleObjectsForSelection().length;
  const channelCount = countNodes(state.visibleRoots, (node) => node.kind === "channel");

  elements.tabChannelsCount.textContent = String(channelCount);
  elements.tabObjectsCount.textContent = String(objectCount);
  elements.tabParametersCount.textContent = String(parameterCount);

  for (const tabButton of elements.tabButtons) {
    const isActive = tabButton.dataset.view === state.viewMode;
    tabButton.classList.toggle("is-active", isActive);
    tabButton.setAttribute("aria-selected", String(isActive));
  }
}

function renderStats() {
  if (!state.model || state.visibleRoots.length === 0) {
    elements.statsText.textContent = "";
    return;
  }

  const channelCount = countNodes(state.visibleRoots, (node) => node.kind === "channel");
  const parameterCount = countNodes(state.visibleRoots, (node) => node.kind === "parameterRef");
  const objectCount = countNodes(state.visibleRoots, (node) => node.kind === "comObjectRef");
  elements.statsText.textContent = `${channelCount} Kanaele, ${parameterCount} Parameter, ${objectCount} KOs`;
}

function renderNavigation() {
  elements.navigationTree.innerHTML = "";

  const entries = buildNavigationEntries(state.visibleRoots);
  if (!state.model || entries.length === 0) {
    elements.navigationTree.append(createEmptyState("Noch keine navigierbaren Seiten erkannt."));
    return;
  }

  for (const entry of entries) {
    elements.navigationTree.append(renderNavigationEntry(entry));
  }
}

function renderNavigationEntry(entry) {
  const containsSelection = entryContainsSelection(entry, state.selectedNodeId);

  if (entry.children.length === 0) {
    const item = document.createElement("div");
    item.className = "nav-item";
    item.append(createNavigationButton(entry));
    return item;
  }

  const details = document.createElement("details");
  details.className = "nav-group nav-branch";
  details.open = containsSelection;

  const summary = document.createElement("summary");
  summary.append(createNavigationButton(entry));
  details.append(summary);

  const branch = document.createElement("div");
  branch.className = "nav-branch";
  for (const childEntry of entry.children) {
    branch.append(renderNavigationEntry(childEntry));
  }
  details.append(branch);
  return details;
}

function createNavigationButton(entry) {
  const label = entry.label || entry.labelNodeId;
  const nodeId = entry.labelNodeId;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nav-link";
  if (nodeId === state.selectedNodeId) {
    button.classList.add("is-selected");
  }

  const icon = createNavigationIcon(entry.icon, label);
  if (icon) {
    button.append(icon);
  }

  const text = document.createElement("span");
  text.className = "nav-link-label";
  text.textContent = label;
  button.append(text);

  button.addEventListener("click", () => {
    state.selectedNodeId = nodeId;
    state.explicitHelpContext = "";
    state.explicitHelpLabel = "";
    render();
  });
  return button;
}

function createNavigationIcon(iconName, label) {
  if (!iconName) {
    return null;
  }

  const shell = document.createElement("span");
  shell.className = "nav-icon-shell";

  const fallback = document.createElement("span");
  fallback.className = "nav-icon-fallback";
  fallback.textContent = deriveIconFallback(iconName, label);
  shell.append(fallback);

  if (!state.selectedSource) {
    return shell;
  }

  const image = document.createElement("img");
  image.className = "nav-icon";
  image.alt = "";
  image.decoding = "async";
  image.loading = "lazy";
  image.src = buildIconUrl(iconName);
  image.addEventListener("load", () => {
    shell.classList.add("has-image");
  });
  image.addEventListener("error", () => {
    image.remove();
  });
  shell.append(image);

  return shell;
}

function deriveIconFallback(iconName, label) {
  const ignoredTokens = new Set(["outline", "multiple", "circle", "variant", "box", "thin", "bold", "small", "like", "card"]);
  const tokens = String(iconName || label || "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !ignoredTokens.has(token.toLowerCase()));

  if (tokens.length === 0) {
    return "?";
  }

  if (tokens.length === 1) {
    return tokens[0].slice(0, 2).toUpperCase();
  }

  return `${tokens[0][0] || ""}${tokens[1][0] || ""}`.toUpperCase();
}

function buildIconUrl(iconName) {
  return `/api/icon?file=${encodeURIComponent(state.selectedSource)}&icon=${encodeURIComponent(iconName)}`;
}

function entryContainsSelection(entry, selectedNodeId) {
  if (!entry || !selectedNodeId) {
    return false;
  }
  if (entry.labelNodeId === selectedNodeId) {
    return true;
  }
  return entry.children.some((childEntry) => entryContainsSelection(childEntry, selectedNodeId));
}

function renderContent() {
  elements.pageContent.innerHTML = "";
  elements.pageMeta.innerHTML = "";

  if (!state.model || !state.selectedNodeId || !state.visibleNodeIds.has(state.selectedNodeId)) {
    elements.breadcrumbs.textContent = "";
    elements.pageTitle.textContent = "Noch keine XML geladen";
    elements.pageContent.append(createEmptyState("Waehle eine XML-Datei, um die XML-Struktur anzuzeigen."));
    return;
  }

  const selectedNode = state.model.nodeIndex.get(state.selectedNodeId);
  if (!selectedNode) {
    elements.pageTitle.textContent = "Auswahl nicht gefunden";
    elements.pageContent.append(createEmptyState("Die ausgewaehlte Seite ist in der aktuellen XML nicht mehr vorhanden."));
    return;
  }

  elements.pageTitle.textContent = resolveTitle(selectedNode, state.derivedState);
  elements.breadcrumbs.textContent = resolveBreadcrumbs(state.model, state.selectedNodeId, state.derivedState).join(" / ");
  renderMetaChip(tabTitleForView(state.viewMode));

  if (state.viewMode === "channels") {
    renderChannelOverview(selectedNode);
    return;
  }

  if (state.viewMode === "objects") {
    renderObjectOverview(selectedNode);
    return;
  }

  renderParameterOverview(selectedNode);
}

function renderMetaChip(text) {
  const chip = document.createElement("span");
  chip.className = "meta-chip";
  chip.textContent = text;
  elements.pageMeta.append(chip);
}

function renderParameterOverview(selectedNode) {
  const visibleNode = materializeNode(selectedNode, state.derivedState);
  const contentNodes = filterRenderableChildren(visibleNode.visibleChildren || [], visibleNode);
  if (contentNodes.length === 0) {
    elements.pageContent.append(createEmptyState("Fuer diese Auswahl sind derzeit keine sichtbaren Inhalte vorhanden."));
    return;
  }

  appendRenderedNodes(elements.pageContent, contentNodes);
}

function renderObjectOverview(selectedNode) {
  const contextNode = getObjectContextNode(selectedNode);
  const objects = collectVisibleObjectsForNode(contextNode);
  if (objects.length === 0) {
    elements.pageContent.append(createEmptyState("Fuer diese Auswahl sind derzeit keine sichtbaren Kommunikationsobjekte vorhanden."));
    return;
  }

  const wrapper = document.createElement("section");
  wrapper.className = "object-table-card section-card";

  const heading = document.createElement("h3");
  heading.className = "section-title";
  heading.textContent = resolveTitle(contextNode, state.derivedState);
  wrapper.append(heading);

  const table = document.createElement("table");
  table.className = "object-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["KO", "Funktion", "DPT", "Groesse"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const objectNode of objects) {
    const description = describeObject(objectNode, state.derivedState);
    const row = document.createElement("tr");
    for (const value of [
      description.text || description.name,
      description.functionText || "-",
      description.datapointType || "-",
      description.objectSize || "-",
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      row.append(td);
    }
    row.addEventListener("click", () => {
      setExplicitHelp(objectNode.helpContext || contextNode.helpContext || "", description.text || description.name);
    });
    tbody.append(row);
  }
  table.append(tbody);
  wrapper.append(table);
  elements.pageContent.append(wrapper);
}

function renderChannelOverview(selectedNode) {
  const rootChannels = state.visibleRoots.filter((node) => node.kind === "channel");
  if (rootChannels.length === 0) {
    elements.pageContent.append(createEmptyState("Es sind derzeit keine Kanaele sichtbar."));
    return;
  }

  const channelGrid = document.createElement("div");
  channelGrid.className = "channel-grid";
  const selectedRootChannel = getSelectedRootChannel(selectedNode);

  for (const channelNode of rootChannels) {
    const card = document.createElement("article");
    card.className = "channel-card";
    if (selectedRootChannel && selectedRootChannel.id === channelNode.id) {
      card.classList.add("is-selected");
    }

    const header = document.createElement("div");
    header.className = "channel-card-heading";

    const icon = createNavigationIcon(channelNode.icon, resolveTitle(channelNode, state.derivedState));
    if (icon) {
      header.append(icon);
    }

    const heading = document.createElement("h3");
    heading.textContent = resolveTitle(channelNode, state.derivedState);
    header.append(heading);
    card.append(header);

    const meta = document.createElement("p");
    meta.className = "channel-meta";
    meta.textContent = `${buildNavigationEntries([channelNode])[0]?.children.length || 0} Unterseiten, ${collectVisibleObjectsForNode(channelNode).length} Kommunikationsobjekte`;
    card.append(meta);

    card.addEventListener("click", () => {
      state.selectedNodeId = channelNode.id;
      state.explicitHelpContext = "";
      state.explicitHelpLabel = "";
      render();
    });

    channelGrid.append(card);
  }

  elements.pageContent.append(channelGrid);
}

function renderNode(node) {
  switch (node.kind) {
    case "parameterBlock":
      return renderParameterBlock(node);
    case "parameterSeparator":
      return renderSeparator(node);
    case "parameterRef":
      return renderField(node);
    case "comObjectRef":
      return renderComObject(node);
    case "button":
      return renderButton(node);
    default:
      return null;
  }
}

function renderParameterBlock(node) {
  if (node.inline && node.layout === "Grid") {
    return renderGridBlock(node);
  }

  const section = document.createElement("section");
  section.className = "section-card";
  if (node.inline) {
    section.classList.add("is-inline");
  }

  const title = resolveTitle(node, state.derivedState);
  const children = filterRenderableChildren(node.visibleChildren || [], node);

  if (title) {
    const header = document.createElement("div");
    header.className = "section-head";

    const titleBox = document.createElement("div");
    const heading = document.createElement(node.inline ? "h4" : "h3");
    heading.className = "section-title";
    heading.textContent = title;
    titleBox.append(heading);
    header.append(titleBox);
    section.append(header);
  }

  const content = document.createElement("div");
  content.className = "section-content";
  appendRenderedNodes(content, children);

  if (!content.childNodes.length) {
    content.append(createEmptyState("Der Block ist vorhanden, zeigt aber aktuell keine sichtbaren Inhalte."));
  }

  section.addEventListener("click", () => {
    setExplicitHelp(node.helpContext || "", title || "Kontexthilfe");
  });
  section.append(content);
  return section;
}

function renderSeparator(node) {
  if (!node.text && node.uiHint !== "HorizontalRuler") {
    return null;
  }

  if (node.uiHint === "HorizontalRuler") {
    const ruler = document.createElement("hr");
    ruler.className = "ruler-separator";
    return ruler;
  }

  if (node.uiHint === "Headline") {
    const wrapper = document.createElement("div");
    wrapper.className = "headline-separator";
    const heading = document.createElement("h3");
    heading.textContent = node.text;
    wrapper.append(heading);
    return wrapper;
  }

  const note = document.createElement("div");
  note.className = "note-card";
  note.textContent = node.text;
  if (node.helpContext) {
    note.addEventListener("click", () => setExplicitHelp(node.helpContext, node.text || "Hinweis"));
  }
  return note;
}

function renderField(node) {
  const description = describeField(node, state.derivedState);
  if (shouldHideField(node, description)) {
    return null;
  }

  const card = document.createElement("div");
  card.className = `field-card is-indented-${Math.min(node.indentLevel || 0, 3)}`;

  const row = document.createElement("div");
  row.className = "field-row";

  const labelBox = document.createElement("div");
  const title = document.createElement("div");
  title.className = "field-title";
  title.textContent = description.text;
  labelBox.append(title);
  row.append(labelBox);

  const inputBox = document.createElement("div");
  inputBox.className = "field-input";
  const control = buildInputControl(node, description);
  inputBox.append(control);
  if (description.suffixText) {
    const suffix = document.createElement("span");
    suffix.className = "field-hint";
    suffix.textContent = description.suffixText;
    inputBox.append(suffix);
  }
  row.append(inputBox);

  card.append(row);
  card.addEventListener("click", () => {
    setExplicitHelp(description.hint || node.helpContext || "", description.text || description.name);
  });
  return card;
}

function buildInputControl(node, description) {
  const typeInfo = description.type || {};
  const typeSignature = `${typeInfo.name || ""} ${typeInfo.uiHint || ""}`;
  const isCheckbox = /checkbox/i.test(typeSignature);
  const isYesNoRadio = /onoffyesno|yesno/i.test(typeSignature);
  const isEnum = Array.isArray(typeInfo.enumerations) && typeInfo.enumerations.length > 0;
  const isNumber = typeInfo.type === "TypeNumber";
  const disabled = description.access === "None";

  if (isYesNoRadio && isEnum) {
    const group = document.createElement("div");
    group.className = "radio-group";
    const options = [...typeInfo.enumerations].sort((left, right) => Number(left.value) - Number(right.value));
    for (const optionInfo of options) {
      const label = document.createElement("label");
      label.className = "radio-option";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = node.paramRefId;
      radio.value = optionInfo.value;
      radio.checked = valuesMatch(optionInfo.value, description.value);
      radio.disabled = disabled;
      radio.addEventListener("change", () => updateParameter(node.paramRefId, optionInfo.value));

      const text = document.createElement("span");
      text.textContent = optionInfo.text || optionInfo.value;

      label.append(radio, text);
      group.append(label);
    }
    return group;
  }

  if (isCheckbox) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = valuesMatch(description.value, "1");
    checkbox.disabled = disabled;
    checkbox.addEventListener("change", () => updateParameter(node.paramRefId, checkbox.checked ? "1" : "0"));
    return checkbox;
  }

  if (isEnum) {
    const select = document.createElement("select");
    select.disabled = disabled;
    for (const enumeration of typeInfo.enumerations) {
      const option = document.createElement("option");
      option.value = enumeration.value;
      option.textContent = enumeration.text || enumeration.value;
      if (valuesMatch(enumeration.value, description.value)) {
        option.selected = true;
      }
      select.append(option);
    }
    select.addEventListener("change", () => updateParameter(node.paramRefId, select.value));
    return select;
  }

  if (isNumber) {
    const input = document.createElement("input");
    input.type = "number";
    input.value = description.value;
    input.disabled = disabled;
    if (typeInfo.minInclusive) {
      input.min = typeInfo.minInclusive;
    }
    if (typeInfo.maxInclusive) {
      input.max = typeInfo.maxInclusive;
    }
    if (typeInfo.increment) {
      input.step = typeInfo.increment;
    }
    input.addEventListener("change", () => updateParameter(node.paramRefId, input.value));
    return input;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.value = description.value;
  input.disabled = disabled;
  input.addEventListener("change", () => updateParameter(node.paramRefId, input.value));
  return input;
}

function renderComObject(node) {
  const description = describeObject(node, state.derivedState);
  const card = document.createElement("article");
  card.className = "object-card";

  const title = document.createElement("div");
  title.className = "object-title";
  title.textContent = description.text || description.name;
  card.append(title);

  if (description.functionText) {
    const functionText = document.createElement("p");
    functionText.className = "object-meta";
    functionText.textContent = description.functionText;
    card.append(functionText);
  }

  const grid = document.createElement("div");
  grid.className = "object-grid";
  for (const item of [
    ["Groesse", description.objectSize],
    ["DPT", description.datapointType],
  ]) {
    if (!item[1]) {
      continue;
    }

    const meta = document.createElement("p");
    meta.className = "object-meta";
    meta.textContent = `${item[0]}: ${item[1]}`;
    grid.append(meta);
  }
  card.append(grid);
  card.addEventListener("click", () => {
    setExplicitHelp(node.helpContext || "", description.text || description.name);
  });
  return card;
}

function renderButton(node) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "disabled-button";
  button.setAttribute("aria-disabled", "true");
  button.textContent = node.text || node.name || "Aktion";
  button.title = node.eventHandler
    ? `Das Ereignis '${node.eventHandler}' wird im Navigator nicht ausgefuehrt.`
    : "Diese Aktion wird im Navigator nicht ausgefuehrt.";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    setExplicitHelp(node.helpContext || "", node.text || node.name || "Aktion");
  });
  return button;
}

function renderGridBlock(node) {
  const layout = extractGridLayout(node);
  const card = document.createElement("section");
  card.className = "grid-card";

  const title = hasExplicitBlockText(node) ? resolveTitle(node, state.derivedState) : "";
  if (title) {
    const heading = document.createElement("div");
    heading.className = "grid-title";
    const headline = document.createElement("h4");
    headline.textContent = title;
    heading.append(headline);
    card.append(heading);
  }

  const scroll = document.createElement("div");
  scroll.className = "grid-scroll";
  const table = document.createElement("table");
  table.className = "grid-table";
  applyGridTableWidth(table, layout.columns);
  scroll.append(table);
  card.append(scroll);

  if (layout.activeRows.length === 0 || layout.maxColumn === 0) {
    const fallback = document.createElement("div");
    fallback.className = "section-content";
    for (const childNode of filterRenderableChildren(node.visibleChildren || [], node)) {
      const rendered = renderNode(childNode);
      if (rendered) {
        fallback.append(rendered);
      }
    }
    if (!fallback.childNodes.length) {
      fallback.append(createEmptyState("Das Grid enthaelt derzeit keine sichtbaren Zellen."));
    }
    scroll.replaceWith(fallback);
    return card;
  }

  table.append(createGridColgroup(layout.columns, layout.maxColumn));

  const tbody = document.createElement("tbody");
  appendGridRows(tbody, layout);
  table.append(tbody);

  if (layout.overflowNodes.length > 0) {
    const overflow = document.createElement("div");
    overflow.className = "section-content";
    for (const childNode of layout.overflowNodes) {
      const rendered = renderNode(childNode);
      if (rendered) {
        overflow.append(rendered);
      }
    }
    card.append(overflow);
  }

  card.addEventListener("click", () => {
    setExplicitHelp(node.helpContext || "", title || "Kontexthilfe");
  });
  return card;
}

function applyGridTableWidth(table, columns) {
  table.style.width = "100%";
}

function appendRenderedNodes(container, nodes) {
  let index = 0;

  while (index < nodes.length) {
    const currentNode = nodes[index];
    if (canMergeGridNode(currentNode)) {
      const groupedNodes = [currentNode];
      const signature = getGridMergeSignature(currentNode);
      let nextIndex = index + 1;

      while (nextIndex < nodes.length && canMergeGridNode(nodes[nextIndex]) && getGridMergeSignature(nodes[nextIndex]) === signature) {
        groupedNodes.push(nodes[nextIndex]);
        nextIndex += 1;
      }

      const rendered = groupedNodes.length > 1 ? renderMergedGridBlocks(groupedNodes) : renderGridBlock(currentNode);
      if (rendered) {
        container.append(rendered);
      }
      index = nextIndex;
      continue;
    }

    const rendered = renderNode(currentNode);
    if (rendered) {
      container.append(rendered);
    }
    index += 1;
  }
}

function canMergeGridNode(node) {
  return node?.kind === "parameterBlock" && node.inline && node.layout === "Grid" && !hasExplicitBlockText(node);
}

function hasExplicitBlockText(node) {
  return Boolean(String(node?.rawText || "").trim());
}

function getGridMergeSignature(node) {
  return (node.columns || []).map((column) => String(column?.width || "")).join("|");
}

function renderMergedGridBlocks(nodes) {
  const firstNode = nodes[0];
  const firstLayout = extractGridLayout(firstNode);
  if (firstLayout.activeRows.length === 0 || firstLayout.maxColumn === 0) {
    return renderGridBlock(firstNode);
  }

  const card = document.createElement("section");
  card.className = "grid-card is-merged-grid";

  const scroll = document.createElement("div");
  scroll.className = "grid-scroll";
  const table = document.createElement("table");
  table.className = "grid-table";
  applyGridTableWidth(table, firstLayout.columns);
  table.append(createGridColgroup(firstLayout.columns, firstLayout.maxColumn));

  const tbody = document.createElement("tbody");
  for (const node of nodes) {
    appendGridRows(tbody, extractGridLayout(node));
  }
  table.append(tbody);
  scroll.append(table);
  card.append(scroll);

  const overflowNodes = nodes.flatMap((node) => extractGridLayout(node).overflowNodes);
  if (overflowNodes.length > 0) {
    const overflow = document.createElement("div");
    overflow.className = "section-content";
    for (const childNode of overflowNodes) {
      const rendered = renderNode(childNode);
      if (rendered) {
        overflow.append(rendered);
      }
    }
    card.append(overflow);
  }

  card.addEventListener("click", () => {
    setExplicitHelp(firstNode.helpContext || "", "Kontexthilfe");
  });
  return card;
}

function extractGridLayout(node) {
  const columns = node.columns || [];
  const itemsByCell = new Map();
  const overflowNodes = [];

  for (const childNode of filterRenderableChildren(node.visibleChildren || [], node)) {
    if (childNode.cell) {
      const key = `${childNode.cell.row}:${childNode.cell.column}`;
      if (!itemsByCell.has(key)) {
        itemsByCell.set(key, []);
      }
      itemsByCell.get(key).push(childNode);
    } else {
      overflowNodes.push(childNode);
    }
  }

  const activeRows = Array.from(new Set(Array.from(itemsByCell.keys()).map((key) => Number(key.split(":")[0]))))
    .filter((rowIndex) => !Number.isNaN(rowIndex))
    .sort((left, right) => left - right);

  const maxColumn = Math.max(columns.length, ...Array.from(itemsByCell.keys()).map((key) => Number(key.split(":")[1])), 0);

  return {
    activeRows,
    columns,
    itemsByCell,
    maxColumn,
    overflowNodes,
  };
}

function createGridColgroup(columns, maxColumn) {
  const colgroup = document.createElement("colgroup");
  const totalPercentWidth = columns.reduce((sum, column) => sum + parsePercentWidth(column?.width), 0);

  for (let columnIndex = 1; columnIndex <= maxColumn; columnIndex += 1) {
    const col = document.createElement("col");
    const column = columns[columnIndex - 1];
    const percentWidth = parsePercentWidth(column?.width);
    if (totalPercentWidth > 0 && percentWidth > 0) {
      col.style.width = `${(percentWidth / totalPercentWidth) * 100}%`;
    } else if (column?.width) {
      col.style.width = column.width;
    }
    colgroup.append(col);
  }

  return colgroup;
}

function appendGridRows(tbody, layout) {
  for (const rowIndex of layout.activeRows) {
    const tr = document.createElement("tr");
    for (let columnIndex = 1; columnIndex <= layout.maxColumn; columnIndex += 1) {
      const td = document.createElement("td");
      const key = `${rowIndex}:${columnIndex}`;
      const stack = document.createElement("div");
      stack.className = "grid-stack";
      for (const cellNode of layout.itemsByCell.get(key) || []) {
        const rendered = renderNode(cellNode);
        if (rendered) {
          stack.append(rendered);
        }
      }
      td.append(stack);
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function parsePercentWidth(widthValue) {
  const match = String(widthValue || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)%$/);
  return match ? Number(match[1]) : 0;
}

function updateParameter(paramRefId, value) {
  state.userState[paramRefId] = value;
  updateDerivedState();
  render();
}

function syncSelectedNode() {
  if (!state.model || state.visibleRoots.length === 0) {
    state.selectedNodeId = null;
    return;
  }

  if (state.selectedNodeId && state.visibleNodeIds.has(state.selectedNodeId)) {
    return;
  }

  state.selectedNodeId = pickInitialNodeId();
  state.explicitHelpContext = "";
  state.explicitHelpLabel = "";
}

function buildNavigationEntries(nodes) {
  return nodes.map((node) => buildNavigationEntry(node)).filter(Boolean);
}

function buildNavigationEntry(node) {
  if (node.kind === "channel") {
    return {
      children: buildNavigationEntries(node.visibleChildren || []),
      icon: node.icon || "",
      label: resolveTitle(node, state.derivedState),
      labelNodeId: node.id,
    };
  }

  if (node.kind === "parameterBlock" && !node.inline) {
    return {
      children: buildNavigationEntries(node.visibleChildren || []),
      icon: node.icon || "",
      label: resolveTitle(node, state.derivedState),
      labelNodeId: node.id,
    };
  }

  return null;
}

function getVisibleRootChannels(nodes) {
  return nodes.filter((node) => node.kind === "channel");
}

function collectVisibleNodeIds(nodes, ids = new Set()) {
  for (const node of nodes) {
    if (node.id) {
      ids.add(node.id);
    }
    if (node.visibleChildren && node.visibleChildren.length > 0) {
      collectVisibleNodeIds(node.visibleChildren, ids);
    }
  }
  return ids;
}

function countNodes(nodes, predicate) {
  let count = 0;
  for (const node of nodes) {
    if (predicate(node)) {
      count += 1;
    }
    if (node.visibleChildren && node.visibleChildren.length > 0) {
      count += countNodes(node.visibleChildren, predicate);
    }
  }
  return count;
}

function countVisibleParametersForSelection() {
  const selectedNode = getSelectedVisibleNode();
  if (!selectedNode) {
    return 0;
  }
  return collectVisibleParametersForNode(selectedNode).length;
}

function collectVisibleParametersForNode(rawNode) {
  const visibleNode = materializeNode(rawNode, state.derivedState);
  const result = [];

  function walk(node, parentNode = null) {
    if (!node) {
      return;
    }

    if (node.kind === "parameterRef") {
      const description = describeField(node, state.derivedState);
      if (!shouldHideField(node, description) && shouldRenderChild(node, parentNode)) {
        result.push(node);
      }
      return;
    }

    for (const childNode of node.visibleChildren || []) {
      walk(childNode, node);
    }
  }

  walk(visibleNode);
  return result;
}

function collectVisibleObjectsForSelection() {
  const selectedNode = getSelectedVisibleNode();
  if (!selectedNode) {
    return [];
  }
  return collectVisibleObjectsForNode(getObjectContextNode(selectedNode));
}

function collectVisibleObjectsForNode(rawNode) {
  if (!rawNode) {
    return [];
  }

  const visibleNode = materializeNode(rawNode, state.derivedState);
  const objects = new Map();

  function walk(node) {
    if (!node) {
      return;
    }

    if (node.kind === "comObjectRef") {
      const key = node.comObjectRef?.id || `${node.refId}:${node.comObject?.name || node.comObjectRef?.text || "ko"}`;
      if (!objects.has(key)) {
        objects.set(key, node);
      }
      return;
    }

    for (const childNode of node.visibleChildren || []) {
      walk(childNode);
    }
  }

  walk(visibleNode);
  return Array.from(objects.values());
}

function getSelectedVisibleNode() {
  if (!state.model || !state.selectedNodeId || !state.visibleNodeIds.has(state.selectedNodeId)) {
    return null;
  }
  return state.model.nodeIndex.get(state.selectedNodeId) || null;
}

function getObjectContextNode(selectedNode) {
  const path = resolveNodePath(state.model, selectedNode.id);
  const preferredPage = [...path].reverse().find((node) => node.kind === "parameterBlock" && node.showInComObjectTree === "true");
  if (preferredPage) {
    return preferredPage;
  }

  return findClosestChannel(path) || selectedNode;
}

function getSelectedRootChannel(selectedNode) {
  if (!selectedNode) {
    return null;
  }

  const path = resolveNodePath(state.model, selectedNode.id);
  return findClosestChannel(path);
}

function findClosestChannel(path) {
  return [...path].reverse().find((node) => node.kind === "channel") || null;
}

function filterRenderableChildren(children, parentNode) {
  return children.filter((childNode) => shouldRenderChild(childNode, parentNode));
}

function shouldRenderChild(node, parentNode) {
  if (!node) {
    return false;
  }

  if (node.kind === "parameterRef") {
    return !shouldHideField(node, describeField(node, state.derivedState));
  }

  return true;
}

function shouldHideField(node, description) {
  if (!description) {
    return true;
  }

  if (description.access === "None") {
    return true;
  }

  const name = description.name || node.parameter?.name || "";
  if (HIDDEN_PARAMETER_NAMES.has(name)) {
    return true;
  }

  if (HIDDEN_PARAMETER_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }

  return !description.text && !name;
}

function renderHelpPanel() {
  if (!state.model || !state.selectedNodeId) {
    elements.helpContext.textContent = "";
    elements.helpTitle.textContent = "Kontexthilfe";
    elements.helpContent.textContent = "Waehle eine Seite oder ein Feld aus, um die zugehoerige Hilfe anzuzeigen.";
    return;
  }

  const helpTarget = resolveHelpTarget();
  const helpText = helpTarget.context ? formatHelpText(state.helpTexts[helpTarget.context] || "") : "";

  elements.helpTitle.textContent = helpTarget.label || "Kontexthilfe";
  elements.helpContext.textContent = helpTarget.context ? `Kontext: ${helpTarget.context}` : "Keine Kontexthilfe vorhanden";
  elements.helpContent.textContent = helpText || "Fuer diese Auswahl ist keine Kontexthilfe hinterlegt.";
}

function resolveHelpTarget() {
  const explicitContext = normalizeHelpContext(state.explicitHelpContext);
  if (explicitContext) {
    return {
      context: explicitContext,
      label: state.explicitHelpLabel || "Kontexthilfe",
    };
  }

  const selectedNode = getSelectedVisibleNode();
  if (!selectedNode) {
    return { context: "", label: "Kontexthilfe" };
  }

  const path = resolveNodePath(state.model, selectedNode.id);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const context = normalizeHelpContext(path[index].helpContext);
    if (context) {
      return {
        context,
        label: resolveTitle(path[index], state.derivedState) || "Kontexthilfe",
      };
    }
  }

  return {
    context: "",
    label: resolveTitle(selectedNode, state.derivedState) || "Kontexthilfe",
  };
}

function setExplicitHelp(helpContext, label) {
  state.explicitHelpContext = normalizeHelpContext(helpContext);
  state.explicitHelpLabel = label || "Kontexthilfe";
  renderHelpPanel();
}

function normalizeHelpContext(helpContext) {
  const normalized = String(helpContext || "").trim();
  if (!normalized || normalized === "Empty") {
    return "";
  }
  return normalized;
}

function formatHelpText(text) {
  return String(text || "").replace(/^#{1,6}\s+/gm, "").trim();
}

function tabTitleForView(viewMode) {
  switch (viewMode) {
    case "channels":
      return "Kanaele";
    case "objects":
      return "Kommunikationsobjekte";
    default:
      return "Parameter";
  }
}

function valuesMatch(left, right) {
  if (left === right) {
    return true;
  }
  if (`${left}` === `${right}`) {
    return true;
  }
  return Number(left) === Number(right);
}

function createEmptyState(text) {
  const emptyState = document.createElement("div");
  emptyState.className = "empty-state";
  emptyState.textContent = text;
  return emptyState;
}

function clearStatus() {
  elements.appStatus.textContent = "";
  elements.appStatus.classList.add("hidden");
  elements.appStatus.style.color = "";
}

function setStatus(text, isError = false) {
  elements.appStatus.textContent = text;
  elements.appStatus.classList.remove("hidden");
  elements.appStatus.style.color = isError ? "var(--accent)" : "var(--muted)";
}

async function safeErrorMessage(response) {
  try {
    const body = await response.json();
    return body.error || "";
  } catch {
    return "";
  }
}